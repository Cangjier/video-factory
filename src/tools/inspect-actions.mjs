/**
 * `video_inspect` actions: media metadata and the acceptance check.
 *
 * `verify` is the last step of every delivery. An empty `problems` array is the only
 * clean result, and its description says so, because a silently wrong resolution or a
 * missing audio track is exactly the kind of thing that ships unnoticed.
 *
 * Reading text off a picture used to live here (`ocr`, `find_text`, `ocr_status`). It is a
 * plugin of its own now (`dsh-ocr`, tools `text_read` / `text_find` / `text_setup`), because
 * recognising text needs an engine, a coordinate space and an install path that have nothing to
 * do with rendering a video.
 *
 * @module video-factory/tools/inspect-actions
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyAgainstPlan } from '../core/deliver.mjs'
import { probe, probeMany } from '../core/probe.mjs'
import { planFrom } from './plan-actions.mjs'
import { VideoFactoryError } from './shared.mjs'

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
  }
}
