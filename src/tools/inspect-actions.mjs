/**
 * `video_inspect` actions: media metadata, the acceptance check, and reading text off an image.
 *
 * `verify` is the last step of every delivery. An empty `problems` array is the only
 * clean result, and its description says so, because a silently wrong resolution or a
 * missing audio track is exactly the kind of thing that ships unnoticed.
 *
 * `ocr` and `find_text` exist for the two questions a vision model cannot answer reliably:
 * what exactly does this picture say, and where on it is that text. They report text with
 * pixel coordinates, which is what makes a located label clickable.
 *
 * @module video-factory/tools/inspect-actions
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyAgainstPlan } from '../core/deliver.mjs'
import { probe, probeMany } from '../core/probe.mjs'
import { OcrError, findLines, ocrReport, parseRegion, readText } from '../core/ocr.mjs'
import { planFrom } from './plan-actions.mjs'
import { VideoFactoryError } from './shared.mjs'

/** How many files one `ocr` call will read. A page of screenshots, not a library. */
const MAX_OCR_FILES = 12

/**
 * Read the OCR options out of a tool call.
 *
 * @param {object} args - the tool arguments.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} options for the core reader.
 */
function ocrOptions(args, config, logger) {
  return {
    config,
    engine: typeof args.engine === 'string' && args.engine !== '' ? args.engine : undefined,
    region: parseRegion(args.region),
    scale: args.scale === undefined ? undefined : args.scale,
    language: typeof args.language === 'string' && args.language !== '' ? args.language : undefined,
    maxSideLen: Number.isFinite(args.maxSideLen) ? args.maxSideLen : undefined,
    minScore: Number.isFinite(args.minScore) ? args.minScore : undefined,
    frames: Number.isFinite(args.frames) ? args.frames : undefined,
    times: Array.isArray(args.times) ? args.times : undefined,
    onLog: (message) => logger.info(`video-factory ocr: ${message}`),
  }
}

/**
 * Build the `video_inspect` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createInspectActions(config, logger) {
  return {
    /**
     * Compare a rendered file with its plan.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the verdict.
     */
    async verify(args, context) {
      const target = typeof args.target === 'string' && args.target !== '' ? resolve(context.cwd, args.target) : null
      if (target === null) {
        throw new VideoFactoryError('video_inspect verify: 需要 "target"（要校验的成片路径）。')
      }
      if (!existsSync(target)) {
        throw new VideoFactoryError(`video_inspect verify: 文件不存在：${target}`)
      }
      const plan = planFrom(args, context.cwd)
      const info = await probe(target, config)
      const problems = verifyAgainstPlan(info, plan)
      if (problems.length > 0) logger.warn(`video-factory verify: ${problems.length} 个问题`)
      return {
        ok: problems.length === 0,
        problems,
        target,
        video: {
          width: info.width,
          height: info.height,
          fps: info.fps,
          duration: info.duration,
          pixFmt: info.pixFmt,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
          hasAudio: info.hasAudio,
          sizeBytes: info.sizeBytes,
        },
        planned: { width: plan.width, height: plan.height, fps: plan.fps, sceneCount: plan.scenes.length },
      }
    },

    /**
     * Report stream metadata for one or more files.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the records, plus any files that could not be read.
     */
    async media(args, context) {
      const requested = []
      if (typeof args.target === 'string' && args.target !== '') requested.push(args.target)
      if (Array.isArray(args.paths)) requested.push(...args.paths.filter((path) => typeof path === 'string' && path !== ''))
      if (requested.length === 0) {
        throw new VideoFactoryError('video_inspect media: 需要 "target" 或 "paths"（一个或多个文件）。')
      }
      const absolute = requested.map((path) => resolve(context.cwd, path))
      const { items, skipped } = await probeMany(absolute, config)
      return { items, skipped, count: items.length }
    },

    /**
     * Read text off an image, or off frames of a video.
     *
     * The result carries every line with its pixel box and score, so the same call answers both
     * "what does it say" and "where does it say it". `text` joins the lines that cleared the
     * score threshold; `lines` is never filtered, because dropping a line the caller wanted is
     * worse than making it skip one.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the recognised text and lines.
     */
    async ocr(args, context) {
      const requested = []
      if (typeof args.target === 'string' && args.target !== '') requested.push(args.target)
      if (Array.isArray(args.paths)) requested.push(...args.paths.filter((path) => typeof path === 'string' && path !== ''))
      if (requested.length === 0) {
        throw new VideoFactoryError('video_inspect ocr: 需要 "target"（图片或视频）或 "paths"（多张图片）。')
      }
      if (requested.length > MAX_OCR_FILES) {
        throw new VideoFactoryError(`video_inspect ocr: 一次最多 ${MAX_OCR_FILES} 个文件，收到 ${requested.length} 个。`)
      }

      const options = ocrOptions(args, config, logger)
      const results = []
      for (const path of requested) {
        try {
          results.push(await readText(resolve(context.cwd, path), options))
        } catch (error) {
          if (error instanceof OcrError) throw new VideoFactoryError(`video_inspect ocr: ${error.message}`)
          throw error
        }
      }

      const summarise = (result) => ({
        path: result.path,
        kind: result.kind,
        engine: result.engine,
        elapsedMs: result.elapsedMs,
        lineCount: result.lines.length,
        dropped: result.dropped ?? 0,
        text: result.text,
        lines: result.lines,
        ...(result.kind === 'video'
          ? {
              duration: result.duration,
              frames: result.frames.map((frame) => ({
                at: frame.at,
                engine: frame.engine,
                lineCount: frame.lines.length,
                text: frame.text,
              })),
            }
          : {}),
        notes: result.notes ?? [],
      })

      if (results.length === 1) return { ok: true, ...summarise(results[0]) }
      return { ok: true, count: results.length, files: results.map(summarise) }
    },

    /**
     * Find text in an image or video frame and report where it is.
     *
     * Matching ignores case and the spaces engines insert between CJK glyphs, so a caller can
     * pass the label as it appears on screen. Every match carries the centre point, which is
     * what a click needs.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the matches, best first.
     */
    async find_text(args, context) {
      const target = typeof args.target === 'string' && args.target !== '' ? resolve(context.cwd, args.target) : null
      if (target === null) {
        throw new VideoFactoryError('video_inspect find_text: 需要 "target"（要搜索的图片或视频）。')
      }
      if (!existsSync(target)) throw new VideoFactoryError(`video_inspect find_text: 文件不存在：${target}`)

      const needles = (Array.isArray(args.needle) ? args.needle : [args.needle]).filter(
        (needle) => typeof needle === 'string' && needle.trim() !== '',
      )
      if (needles.length === 0) {
        throw new VideoFactoryError('video_inspect find_text: 需要 "needle"（要查找的文字，可给数组）。')
      }

      // Matching must see every line the engine produced, including low-confidence ones: a
      // 0.4-score line that says exactly what was asked for is a hit, not noise.
      const options = { ...ocrOptions(args, config, logger), minScore: 0 }
      let result
      try {
        result = await readText(target, options)
      } catch (error) {
        if (error instanceof OcrError) throw new VideoFactoryError(`video_inspect find_text: ${error.message}`)
        throw error
      }

      const matches = findLines(result.lines, needles, { match: args.match })
      return {
        ok: matches.length > 0,
        target,
        engine: result.engine,
        elapsedMs: result.elapsedMs,
        needles,
        lineCount: result.lines.length,
        matchCount: matches.length,
        best: matches[0] ?? null,
        matches,
        searched: result.lines.map((line) => line.text),
        notes: [
          ...(result.notes ?? []),
          ...(matches.length === 0
            ? [
                `没有找到 ${needles.map((needle) => JSON.stringify(needle)).join(' / ')}。` +
                  '已识别的每一行都在 searched 里；若目标文字很小，先用 region 只截取它周围一块再试，' +
                  '小字在整屏里会被缩小到读不出来。',
              ]
            : []),
        ],
      }
    },

    /**
     * Report OCR availability without reading anything.
     * @returns {object} the engine report.
     */
    ocr_status() {
      return ocrReport(config)
    },
  }
}
