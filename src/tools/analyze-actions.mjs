/**
 * `video_analyze` actions: adaptive frame sampling and audio event detection.
 *
 * Both actions are measurements. `sample_frames` says where the cuts and the movement are;
 * `audio_events` says what the soundtrack is and when. Neither says which shot to use, how
 * long to hold it, or whether the result is any good — that stays with DSH.
 *
 * @module video-factory/tools/analyze-actions
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run } from '../core/ffmpeg.mjs'
import { sampleFrames } from '../core/sampling.mjs'
import { AUDIO_TMP_DIR, detectAudioEvents, audioEventState } from '../core/audio-events.mjs'
import { audioInstallState } from '../core/audio-install.mjs'
import { PLUGIN_ROOT } from '../core/env.mjs'
import { VideoFactoryError } from './shared.mjs'

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
  }
}
