/**
 * `video_analyze` actions: adaptive frame sampling, audio event detection, and matting.
 *
 * Every action here is a measurement or a transform of the analysis kind. `sample_frames` says
 * where the cuts and the movement are; `audio_events` says what the soundtrack is and when;
 * `matte` separates a subject from its backdrop. None of them says which shot to use, how long to
 * hold it, or whether the result is any good — that stays with DSH.
 *
 * @module video-factory/tools/analyze-actions
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run } from '../core/ffmpeg.mjs'
import { sampleFrames } from '../core/sampling.mjs'
import { AUDIO_TMP_DIR, detectAudioEvents, audioEventState } from '../core/audio-events.mjs'
import { audioInstallState } from '../core/audio-install.mjs'
import { MATTE_TMP_DIR, matteImage, matteState, planMasks } from '../core/matte.mjs'
import { matteInstallState } from '../core/matte-install.mjs'
import { PLUGIN_ROOT } from '../core/env.mjs'
import { VideoFactoryError } from './shared.mjs'

/** Where matted PNGs go when no directory is named. */
const DEFAULT_MATTE_DIR = join(PLUGIN_ROOT, 'tmp', 'matte', 'out')

/** Where extracted frames go when no directory is named. */
const DEFAULT_FRAME_DIR = join(PLUGIN_ROOT, 'tmp', 'frames')

/** Ceiling on extracted JPEGs in one call: this is a look, not a script. */
const MAX_EXTRACTS = 60

/** Default long side of an extracted JPEG. Every frame becomes an image someone must read. */
const DEFAULT_MAX_SIDE = 640

/**
 * Pull the sampling options out of a tool call, dropping anything the caller left out so the
 * core module's defaults apply rather than `undefined` overwriting them.
 *
 * @param {object} args - the tool arguments.
 * @returns {object} options for `core/sampling.mjs`.
 */
function samplingOptions(args) {
  const options = {}
  for (const key of [
    'strategy',
    'probeFps',
    'targetFps',
    'sceneThreshold',
    'motionThreshold',
    'minFps',
    'maxFps',
    'maxFrames',
  ]) {
    if (args[key] !== undefined && args[key] !== null) options[key] = args[key]
  }
  return options
}

/**
 * Write one frame of a video to a JPEG.
 *
 * `-ss` before `-i` seeks by keyframe and is fast; the timestamps handed in come from a
 * decoded proxy, so an approximation of a few tens of milliseconds is not a problem here —
 * the frame is for looking at, not for frame-exact work.
 *
 * @param {string} source - the video.
 * @param {number} at - the second to capture.
 * @param {string} target - the JPEG path.
 * @param {object} options - `{ config, maxSide, timeoutMs }`.
 * @returns {Promise<string>} the target path.
 */
async function extractJpeg(source, at, target, options) {
  const maxSide = Number.isFinite(options.maxSide) && options.maxSide > 0 ? options.maxSide : DEFAULT_MAX_SIDE
  await run({
    tool: 'ffmpeg',
    args: [
      '-ss', at.toFixed(3),
      '-i', source,
      '-frames:v', '1',
      '-vf', `scale='if(gt(iw,ih),${maxSide},-2)':'if(gt(iw,ih),-2,${maxSide})'`,
      '-q:v', '3',
      '-update', '1',
      target,
    ],
    config: options.config ?? {},
    timeoutMs: options.timeoutMs ?? 120_000,
  })
  return target
}

/**
 * Turn a core error into a tool error the model can act on.
 * @param {string} action - the action that failed.
 * @param {Error} error - the thrown error.
 * @returns {VideoFactoryError} the error to throw.
 */
function asToolError(action, error) {
  const message = error instanceof Error ? error.message : String(error)
  return new VideoFactoryError(`video_analyze ${action}: ${message}`)
}

/**
 * Build the `video_analyze` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createAnalyzeActions(config, logger) {
  return {
    /**
     * Sample the moments of a video worth looking at.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the sampling report.
     */
    async sample_frames(args, context) {
      if (typeof args.target !== 'string' || args.target === '') {
        throw new VideoFactoryError('video_analyze sample_frames: 需要 "target"（要分析的视频路径）。')
      }
      const target = resolve(context.cwd, args.target)
      if (!existsSync(target)) {
        throw new VideoFactoryError(`video_analyze sample_frames: 文件不存在：${target}`)
      }

      let report
      try {
        report = await sampleFrames(target, {
          ...samplingOptions(args),
          config,
          onProgress: (message) => logger.info(`video-factory analyze: ${message}`),
        })
      } catch (error) {
        throw asToolError('sample_frames', error)
      }

      if (args.extract !== true) return report

      const wanted = report.frames.slice(0, MAX_EXTRACTS)
      const skipped = report.frames.length - wanted.length
      const outDir = typeof args.outDir === 'string' && args.outDir !== ''
        ? resolve(context.cwd, args.outDir)
        : DEFAULT_FRAME_DIR
      mkdirSync(outDir, { recursive: true })

      const extracted = []
      for (const [position, frame] of wanted.entries()) {
        const name = `${String(position).padStart(3, '0')}_${frame.at.toFixed(2).replace('.', '_')}s_${frame.reason}.jpg`
        const path = join(outDir, name)
        try {
          await extractJpeg(target, frame.at, path, { config, maxSide: args.maxSide })
          frame.file = path
          extracted.push({ at: frame.at, reason: frame.reason, path })
        } catch (error) {
          // One unreadable frame must not discard the whole sampling result.
          frame.file = null
          frame.error = error instanceof Error ? error.message : String(error)
        }
      }

      return {
        ...report,
        extract: {
          directory: outDir,
          requested: report.frames.length,
          written: extracted.length,
          truncated: skipped > 0 ? skipped : 0,
          maxSide: Number.isFinite(args.maxSide) ? args.maxSide : DEFAULT_MAX_SIDE,
          note:
            '这些 JPEG 是留给你看的：逐张读图判断画面内容与构图，那正是分值给不出的东西。',
        },
      }
    },

    /**
     * Classify a soundtrack into timestamped acoustic events.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the audio event report.
     */
    async audio_events(args, context) {
      if (typeof args.target !== 'string' || args.target === '') {
        throw new VideoFactoryError('video_analyze audio_events: 需要 "target"（要分析的视频或音频路径）。')
      }
      const target = resolve(context.cwd, args.target)
      if (!existsSync(target)) {
        throw new VideoFactoryError(`video_analyze audio_events: 文件不存在：${target}`)
      }

      try {
        const report = await detectAudioEvents(target, {
          config,
          start: Number.isFinite(args.start) ? args.start : undefined,
          duration: Number.isFinite(args.duration) ? args.duration : undefined,
          topK: Number.isFinite(args.topK) ? args.topK : undefined,
          minScore: Number.isFinite(args.minScore) ? args.minScore : undefined,
          silenceRms: Number.isFinite(args.silenceRms) ? args.silenceRms : undefined,
          onProgress: (progress) => {
            if (progress.done % 25 === 0 || progress.done === progress.total) {
              logger.info(`video-factory analyze: 音频分类 ${progress.done}/${progress.total}`)
            }
          },
        })
        if (args.includeSegments === false) {
          const { segments, ...rest } = report
          return { ...rest, segmentCount: segments.length }
        }
        return report
      } catch (error) {
        throw asToolError('audio_events', error)
      }
    },

    /**
     * Report whether audio event detection is installed.
     * @returns {object} the state.
     */
    async audio_status() {
      const state = audioEventState()
      if (!state.available) {
        return { ...state, installWith: 'video_env {action:"install_audio"}' }
      }
      const installed = audioInstallState()
      return {
        available: state.available,
        kind: state.kind,
        classes: state.classes,
        vendorDir: state.vendorDir,
        fileCount: installed.fileCount,
        totalBytes: installed.totalBytes,
        modelBytes: installed.modelBytes,
        runtimeBytes: installed.runtimeBytes,
        model: state.model,
        runtime: state.runtime,
        scratchDir: AUDIO_TMP_DIR,
      }
    },

    /**
     * Cut a subject out of its backdrop.
     *
     * One image, or if `at` is given, one frame of a video. Deliberately not a whole video: the
     * measured cost is about two seconds per frame on one WASM thread, so a caller has to decide
     * per frame whether it is worth it. The plan-level `matte` block is the route for a video,
     * because there `maskFps` makes the trade-off explicit.
     *
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the matte report.
     */
    async matte(args, context) {
      if (typeof args.target !== 'string' || args.target === '') {
        throw new VideoFactoryError('video_analyze matte: 需要 "target"（要抠图的图片或视频）。')
      }
      const source = resolve(context.cwd, args.target)
      if (!existsSync(source)) {
        throw new VideoFactoryError(`video_analyze matte: 文件不存在：${source}`)
      }

      const outDir = typeof args.outDir === 'string' && args.outDir !== ''
        ? resolve(context.cwd, args.outDir)
        : DEFAULT_MATTE_DIR
      mkdirSync(outDir, { recursive: true })
      const stem = args.name === undefined ? 'matte' : String(args.name).replace(/[^\w.-]+/g, '_')
      const target = join(outDir, `${stem}.png`)

      try {
        const result = await matteImage(source, target, {
          config,
          at: Number.isFinite(args.at) ? args.at : undefined,
          feather: Number.isFinite(args.feather) ? args.feather : undefined,
          keepMask: args.keepMask === true,
        })
        const degenerate =
          result.statistics.foregroundRatio < 0.005 || result.statistics.foregroundRatio > 0.995
        return {
          ...result,
          warnings: degenerate
            ? [
                `遮罩几乎全为${result.statistics.foregroundRatio > 0.5 ? '前景' : '背景'}` +
                  `（前景占比 ${(result.statistics.foregroundRatio * 100).toFixed(2)}%），` +
                  '模型可能没在这张图上找到主体；请先看这张 PNG 再决定是否使用。',
              ]
            : [],
          notes: [
            '输出是带 alpha 的 PNG，可直接作为图层素材。',
            '模型固定 320x320 输入，遮罩被放大回原尺寸；边缘靠 feather 平滑，不靠模型精度。',
          ],
        }
      } catch (error) {
        throw asToolError('matte', error)
      }
    },

    /**
     * Report whether the matting model is installed, and what a video matte would cost.
     *
     * @param {object} args - the tool arguments.
     * @returns {object} the state.
     */
    async matte_status(args = {}) {
      const state = matteState()
      if (!state.available) {
        return {
          ...state,
          installWith: state.missing.includes('model')
            ? 'video_env {action:"install_matte"}'
            : 'video_env {action:"install_audio"}（推理运行时由它提供）',
        }
      }
      const installed = matteInstallState()
      const response = {
        available: true,
        model: state.model,
        runtime: state.runtime,
        modelBytes: installed.installedBytes,
        runtimeShared: true,
        runtimeDir: state.runtimeDir,
        scratchDir: MATTE_TMP_DIR,
        measuredMsPerMask: 2071,
        notes: [
          '抠图与音频事件检测共用同一个 WASM 运行时（vendor/audio/runtime），所以抠图本身只占 4.36 MB。',
          '实测单帧 320x320 约 2.1 秒（单线程 WASM，CPU）。多线程实测仅 1.08x，所以不做线程池。',
        ],
      }
      // If a duration is supplied, answer the question the caller actually has: what will this
      // cost? The rate is theirs to choose, so this reports rather than decides.
      if (Number.isFinite(args.duration) && args.duration > 0) {
        response.cost = [4, 8, 12, 30]
          .filter((fps) => fps <= 30)
          .map((maskFps) => {
            const plan = planMasks({ maskFps, duration: Number(args.duration), estimatedMsPerMask: 2071 })
            return {
              maskFps,
              masks: plan.masks,
              estimatedMinutes: plan.estimatedSeconds === null ? null : Number((plan.estimatedSeconds / 60).toFixed(1)),
            }
          })
        response.costNote =
          '遮罩率由调用方决定：越高过渡越顺、耗时越长。每个遮罩会被保持到下一个遮罩出现，所以低遮罩率的代价是遮罩边缘的跳动。'
        response.interpolationNote =
          '在 plan 的 matte 块里把 interpolate 设为 blend，可以在同样的 maskFps 下把边缘跳动换成平滑过渡——' +
          '实测在柔边遮罩上把 48 帧里 7 帧变化提升到 42 帧，只多花约 9 ms 滤镜时间（相对每遮罩约 2.1 秒的推理可忽略），' +
          '边缘锐度只降 1.3%。所以追求平滑时先调 interpolate，再考虑抬高 maskFps。'
      }
      return response
    },
  }
}
