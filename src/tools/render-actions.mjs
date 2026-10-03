/**
 * `video_render` actions: the four pipeline stages plus the whole chain.
 *
 * Every action takes the same plan and derives its directories the same way, so the
 * stages can be called in any order and a re-run lands in the same place. `force`
 * overrides the fingerprint-based reuse; without it, a stage whose inputs are
 * unchanged is skipped and reported as reused.
 *
 * @module video-factory/tools/render-actions
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { assemble, timelinePath } from '../core/assemble.mjs'
import { deliver } from '../core/deliver.mjs'
import { finalize } from '../core/finalize.mjs'
import { build, normalizeScenes } from '../core/pipeline.mjs'
import { clipPath, renderScene } from '../core/scene.mjs'
import { planFrom } from './plan-actions.mjs'
import { VideoFactoryError } from './shared.mjs'

/**
 * Resolve the directories a render writes to.
 *
 * The defaults are derived from the plan's own location so that a plan and its output
 * stay together, which is what makes a project folder portable.
 * @param {object} args - the tool arguments.
 * @param {object} plan - the resolved plan.
 * @param {string} cwd - the working directory.
 * @returns {{outDir: string, workDir: string}} absolute directories.
 */
function directoriesFor(args, plan, cwd) {
  const planDir = plan.baseDir ?? cwd
  const outDir =
    typeof args.outDir === 'string' && args.outDir.trim() !== ''
      ? resolve(cwd, args.outDir)
      : resolve(planDir, 'output')
  const workDir =
    typeof args.workDir === 'string' && args.workDir.trim() !== ''
      ? resolve(cwd, args.workDir)
      : join(outDir, '.work')
  return { outDir, workDir }
}

/**
 * A progress callback that narrates ffmpeg's own output at debug volume.
 * @param {object} logger - the host plugin's logger.
 * @param {string} label - a prefix naming the stage.
 * @returns {(line: string) => void} the callback.
 */
function progressLogger(logger, label) {
  let last = 0
  return (line) => {
    // ffmpeg emits many lines per second; keep the log useful rather than exhaustive.
    const now = Date.now()
    if (now - last < 1000) return
    last = now
    logger.info(`video-factory ${label}: ${line.trim()}`)
  }
}

/** Report one stage outcome in a shape every render action shares. */
function stageResult(name, detail, outputs, seconds) {
  return { stage: name, detail, outputs, seconds: Number(seconds.toFixed(2)) }
}

/**
 * Build the `video_render` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createRenderActions(config, logger) {
  /** Load the plan and derive directories; shared by every action. */
  const prepare = (args, context) => {
    const plan = planFrom(args, context.cwd)
    if (typeof args.quality === 'string' && args.quality !== '') plan.quality = args.quality
    const { outDir, workDir } = directoriesFor(args, plan, context.cwd)
    mkdirSync(workDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    return { plan, outDir, workDir }
  }

  return {
    /**
     * Render one or all scenes to uniform intermediate clips.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the clip paths and what was reused.
     */
    async scene(args, context) {
      const { plan, workDir } = prepare(args, context)
      const targets =
        typeof args.sceneId === 'string' && args.sceneId !== ''
          ? plan.scenes.map((scene, index) => ({ scene, index })).filter(({ scene }) => scene.id === args.sceneId)
          : plan.scenes.map((scene, index) => ({ scene, index }))
      if (targets.length === 0) {
        throw new VideoFactoryError(
          `video_render scene: 计划里没有 id 为 ${args.sceneId} 的镜头。可用：${plan.scenes.map((s) => s.id).join(', ')}`,
        )
      }

      const rendered = []
      for (const { scene, index } of targets) {
        logger.info(`video-factory: 渲染镜头 ${scene.id}（第 ${index + 1}/${plan.scenes.length}）`)
        const result = await renderScene(scene, plan, index, {
          workDir,
          force: args.force === true,
          config,
          pathBudget: config.pathBudget,
          onProgress: progressLogger(logger, `镜头 ${scene.id}`),
        })
        rendered.push({ sceneId: scene.id, path: result.path, reused: result.reused, seconds: Number(result.seconds.toFixed(2)) })
      }

      return {
        workDir,
        clips: plan.scenes.map((scene, index) => clipPath(workDir, index, scene.id)),
        rendered,
        reusedCount: rendered.filter((entry) => entry.reused).length,
        note: args.force === true ? 'force 已开启，全部重渲染' : '已存在的片段被复用；改动镜头参数后请传 force: true',
      }
    },

    /**
     * Join the normalized clips into one timeline.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the timeline path.
     */
    async assemble(args, context) {
      const { plan, workDir } = prepare(args, context)
      const clips =
        Array.isArray(args.clips) && args.clips.length > 0
          ? args.clips.map((clip) => resolve(context.cwd, clip))
          : plan.scenes.map((scene, index) => clipPath(workDir, index, scene.id))

      const missing = clips.filter((clip) => !existsSync(clip))
      if (missing.length > 0) {
        throw new VideoFactoryError(
          `video_render assemble: ${missing.length} 个片段还不存在，请先渲染它们。第一个缺失的是 ${missing[0]}。` +
            '（提示：先调用 video_render {action:"scene"}。）',
        )
      }

      const result = await assemble(clips, plan, {
        workDir,
        force: args.force === true,
        config,
        onProgress: progressLogger(logger, '拼接'),
      })
      return { ...stageResult('assemble', result.detail, [result.path], result.seconds), reused: result.reused, timeline: result.path }
    },

    /**
     * Mix audio, normalize loudness, and add subtitles.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the finished file.
     */
    async finalize(args, context) {
      const { plan, outDir, workDir } = prepare(args, context)
      const timeline =
        typeof args.timeline === 'string' && args.timeline !== ''
          ? resolve(context.cwd, args.timeline)
          : timelinePath(workDir)
      if (!existsSync(timeline)) {
        throw new VideoFactoryError(
          `video_render finalize: 找不到时间线 ${timeline}，请先调用 video_render {action:"assemble"}。`,
        )
      }

      const result = await finalize(timeline, plan, {
        workDir,
        outDir,
        force: args.force === true,
        config,
        onProgress: progressLogger(logger, '合成'),
      })
      return {
        ...stageResult('finalize', `${result.duration.toFixed(1)}s 成片`, [result.path], result.seconds),
        reused: result.reused,
        output: result.path,
        duration: result.duration,
        subtitlesBurned: result.burned,
        softSubtitles: result.softSubs,
      }
    },

    /**
     * Write the cover frame, the contact sheet, and the acceptance report.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the report, including `problems`.
     */
    async deliver(args, context) {
      const { plan, outDir, workDir } = prepare(args, context)
      const target = join(outDir, 'final.mp4')
      if (!existsSync(target) || statSync(target).size === 0) {
        throw new VideoFactoryError(
          `video_render deliver: 还没有成片 ${target}，请先调用 video_render {action:"finalize"}。`,
        )
      }
      const report = await deliver(target, plan, {
        outDir,
        config,
        onProgress: progressLogger(logger, '交付'),
      })
      if (report.problems.length > 0) {
        logger.warn(`video-factory: 验收发现 ${report.problems.length} 个问题，必须转达给用户`)
      }
      return report
    },

    /**
     * Run all four stages in sequence.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the delivery report.
     */
    async build(args, context) {
      const { plan, outDir, workDir } = prepare(args, context)
      logger.info(`video-factory: 整链渲染 ${plan.scenes.length} 个镜头到 ${outDir}`)
      const report = await build(plan, {
        outDir,
        workDir,
        force: args.force === true,
        config,
        onProgress: (event) => {
          if (event.phase === 'scene') logger.info(`video-factory: 渲染镜头 ${event.sceneId}（${event.index + 1}/${plan.scenes.length}）`)
        },
      })
      if (report.problems.length > 0) {
        logger.warn(`video-factory: 验收发现 ${report.problems.length} 个问题，必须转达给用户`)
      }
      return report
    },
  }
}
