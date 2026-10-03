/**
 * The whole render, stage by stage.
 *
 * Each stage is a separate exported function so that a failure is attributable and a
 * re-run is cheap — changing one scene re-encodes that scene, changing a subtitle style
 * re-runs only finalize. `build` exists for callers that want the chain run in one
 * call, and it makes no decisions: every choice comes from the plan.
 *
 * @module video-factory/core/pipeline
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { assemble } from './assemble.mjs'
import { deliver } from './deliver.mjs'
import { finalize } from './finalize.mjs'
import { clipPath, renderScene } from './scene.mjs'

/**
 * Render every scene to a uniform intermediate clip.
 *
 * @param {object} plan - the plan.
 * @param {object} options - render options.
 * @param {string} options.workDir - scratch directory.
 * @param {boolean} [options.force] - re-encode clips that already exist.
 * @param {string} [options.only] - render just this scene id.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(event: object) => void} [options.onProgress] - progress events.
 * @returns {Promise<{clips: string[], stages: object[]}>} clip paths and stage logs.
 */
export async function normalizeScenes(plan, options) {
  mkdirSync(join(options.workDir, 'scenes'), { recursive: true })
  const clips = []
  const stages = []
  const started = Date.now()
  const selected = plan.scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene }) => options.only === undefined || options.only === null || scene.id === options.only)

  if (selected.length === 0) {
    throw new Error(`计划里没有 id 为 ${options.only} 的镜头`)
  }

  for (const { scene, index } of selected) {
    options.onProgress?.({ phase: 'scene', sceneId: scene.id, index })
    const result = await renderScene(scene, plan, index, {
      workDir: options.workDir,
      force: options.force,
      config: options.config,
      pathBudget: options.pathBudget,
      onProgress: options.onProgress === undefined ? undefined : (line) => options.onProgress({ phase: 'ffmpeg', sceneId: scene.id, line }),
    })
    clips.push(result.path)
  }

  // When rendering a subset, report the full planned clip list so a later assemble has
  // every path it needs in plan order.
  const allClips = plan.scenes.map((scene, index) => clipPath(options.workDir, index, scene.id))
  stages.push({
    name: 'normalize',
    seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
    detail: `${selected.length} 个镜头${options.only === undefined ? '' : `（仅 ${options.only}）`}`,
    outputs: clips,
  })
  return { clips: allClips, stages }
}

/**
 * Run the whole pipeline and return the delivery report.
 *
 * @param {object} plan - the plan.
 * @param {object} options - build options.
 * @param {string} options.outDir - destination for the delivered files.
 * @param {string} [options.workDir] - scratch directory; defaults to `<outDir>/.work`.
 * @param {boolean} [options.force] - redo every stage.
 * @param {object} [options.config] - normalized plugin config.
 * @param {(event: object) => void} [options.onProgress] - progress events.
 * @returns {Promise<object>} the report, including `problems`.
 */
export async function build(plan, options) {
  const workDir = options.workDir ?? join(options.outDir, '.work')
  const stages = []

  const normalized = await normalizeScenes(plan, { ...options, workDir })
  stages.push(...normalized.stages)

  const timeline = await assemble(normalized.clips, plan, {
    workDir,
    force: options.force,
    config: options.config,
    onProgress: options.onProgress === undefined ? undefined : (line) => options.onProgress({ phase: 'ffmpeg', line }),
  })
  stages.push({
    name: 'assemble',
    seconds: Number(timeline.seconds.toFixed(2)),
    detail: timeline.detail,
    outputs: [timeline.path],
  })

  const finished = await finalize(timeline.path, plan, {
    workDir,
    outDir: options.outDir,
    force: options.force,
    config: options.config,
    onProgress: options.onProgress === undefined ? undefined : (line) => options.onProgress({ phase: 'ffmpeg', line }),
  })
  stages.push({
    name: 'finalize',
    seconds: Number(finished.seconds.toFixed(2)),
    detail: `${finished.duration.toFixed(1)}s 成片${finished.burned ? '（字幕已烧录）' : finished.softSubs ? '（软字幕）' : ''}`,
    outputs: [finished.path],
  })

  return deliver(finished.path, plan, {
    outDir: options.outDir,
    stages,
    config: options.config,
    onProgress: options.onProgress === undefined ? undefined : (line) => options.onProgress({ phase: 'ffmpeg', line }),
  })
}

export { assemble, deliver, finalize, renderScene }
