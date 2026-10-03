/**
 * `video_plan` actions: validation, timeline arithmetic, the field reference, and a
 * diagnosis pass.
 *
 * Nothing here writes a plan or repairs one. `check` either passes or lists problems,
 * and `diagnose` reports only facts that are objectively wrong — a missing file, a
 * still with no motion, a transition longer than its scene. It never suggests a
 * reorder or a different pace, because taste is not its department.
 *
 * @module video-factory/tools/plan-actions
 */
import { existsSync } from 'node:fs'
import {
  PlanError,
  PRESETS,
  effectiveOverlap,
  estimatedDuration,
  fieldReference,
  loadPlan,
  missingFiles,
  parsePlan,
  resolvePlanPaths,
} from '../core/plan.mjs'
import { probe } from '../core/probe.mjs'
import { VideoFactoryError } from './shared.mjs'

/**
 * A person-readable list of what a plan is allowed to say, used in error messages.
 * @returns {string} the hint text.
 */
function presetHint() {
  return Object.keys(PRESETS).join(', ')
}

/**
 * Whether the caller supplied a plan at all.
 *
 * Distinguished from "the plan is invalid": a missing argument is a calling mistake and
 * must throw, while an invalid plan is a validation result the model needs to read.
 * @param {object} args - the tool arguments.
 * @returns {boolean} whether a plan or inline document was supplied.
 */
export function hasPlanInput(args) {
  if (args.planData !== undefined && args.planData !== null) return true
  return typeof args.plan === 'string' && args.plan.trim() !== ''
}

/**
 * Load a plan from either an inline document or a path.
 *
 * Inline documents resolve their relative paths against the working directory, which
 * is what makes "check this plan before writing it" possible.
 * @param {object} args - the tool arguments.
 * @param {string} cwd - the working directory.
 * @returns {object} the validated plan, with paths resolved but not verified.
 * @throws {VideoFactoryError} when neither form is supplied.
 */
export function planFrom(args, cwd) {
  if (args.planData !== undefined && args.planData !== null) {
    try {
      return resolvePlanPaths(parsePlan(args.planData, cwd))
    } catch (error) {
      if (error instanceof PlanError) throw new VideoFactoryError(`计划校验失败：${error.message}`)
      throw error
    }
  }
  if (typeof args.plan === 'string' && args.plan.trim() !== '') {
    try {
      return resolvePlanPaths(loadPlan(args.plan))
    } catch (error) {
      if (error instanceof PlanError) throw new VideoFactoryError(`${error.message}`)
      throw error
    }
  }
  throw new VideoFactoryError(
    `video_plan: 需要 "plan"（plan.json 路径）或 "planData"（内联计划对象）。可用画布预设：${presetHint()}`,
  )
}

/**
 * Check whether the plan's references are all present and report objective smells.
 *
 * @param {object} plan - a resolved plan.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<string[]>} findings, which are warnings rather than errors.
 */
async function diagnoseFindings(plan, config) {
  const findings = []

  for (const scene of plan.scenes) {
    if (scene.kind !== 'image') continue
    if (scene.motion === 'none') {
      findings.push(`scenes[${scene.id}].motion 是 "none"：静止图没有运动会显得呆板`)
    }
    if (scene.transition.type !== 'none' && scene.transition.duration > scene.duration * 0.5) {
      findings.push(
        `scenes[${scene.id}].transition.duration ${scene.transition.duration}s 超过该镜头时长的一半` +
          `（${scene.duration}s），实际会被裁剪到 ${scene.duration * 0.5}s`,
      )
    }
  }

  // Orientation mix: a portrait canvas fed mostly landscape stills will crop heavily.
  const portraitCanvas = plan.height > plan.width
  const stills = plan.scenes.filter((scene) => scene.kind === 'image' && scene.resolved !== null)
  if (stills.length > 0) {
    let mismatched = 0
    for (const scene of stills) {
      try {
        const info = await probe(scene.resolved, config ?? {})
        const landscape = info.width > info.height
        if (portraitCanvas === landscape) mismatched += 1
      } catch {
        // A file that cannot be probed is already reported by the missing-file pass.
      }
    }
    if (mismatched > 0) {
      findings.push(
        `${mismatched}/${stills.length} 张静止图的方向与画布相反（画布 ${plan.width}x${plan.height}），` +
          '会被 fit 裁切；如果取景重要，考虑 fit: "contain" 或 "blur-pad"',
      )
    }
  }

  // Audio timing: a large mismatch means the picture was never cut to the narration.
  if (plan.audio.voiceover !== null && existsSync(plan.audio.voiceover)) {
    try {
      const voice = await probe(plan.audio.voiceover, config ?? {})
      const timeline = estimatedDuration(plan.scenes)
      const delta = timeline - voice.duration
      if (Math.abs(delta) > Math.max(2, voice.duration * 0.15)) {
        findings.push(
          `时间轴 ${timeline.toFixed(2)}s 与配音 ${voice.duration.toFixed(2)}s 相差 ${delta.toFixed(2)}s，` +
            '画面与旁白会对不齐',
        )
      }
    } catch {
      // Reported as a missing or unreadable file elsewhere.
    }
  }

  if (plan.subtitles.enabled && plan.subtitles.source === null) {
    findings.push('subtitles.enabled 为 true 但 subtitles.source 是 null，渲染时不会有字幕')
  }
  if (plan.subtitles.enabled && plan.subtitles.source === 'auto') {
    findings.push('subtitles.source 为 "auto"，但本插件不会自动生成字幕；请先用 video_narrate 产出 .srt 并填入路径')
  }
  if (plan.audio.voiceover === null && plan.audio.keepSceneAudio === false) {
    findings.push('没有配音，同时 keep_scene_audio 为 false：成片会几乎没有声音')
  }

  return findings
}

/**
 * Build the `video_plan` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createPlanActions(config, logger) {
  return {
    /**
     * Validate a plan and report every structural problem at once.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context, supplying `cwd`.
     * @returns {Promise<object>} the verdict.
     */
    async check(args, context) {
      // A missing argument is a calling mistake, so it throws. An invalid plan is a
      // result, because the message is exactly what the model needs in order to fix it.
      if (!hasPlanInput(args)) planFrom(args, context.cwd)

      let plan
      try {
        plan = planFrom(args, context.cwd)
      } catch (error) {
        return { ok: false, errors: [error.message], findings: [], normalized: null }
      }

      // Missing files are errors; the rest are observations. When something is an
      // error the observations are still returned, because fixing one round of
      // problems usually reveals the next and a single call should show both.
      const errors = missingFiles(plan, existsSync)
      const findings = await diagnoseFindings(plan, config)
      if (errors.length > 0) logger.warn(`video_plan check: ${errors.length} 个错误`)

      return {
        ok: errors.length === 0 && (!args.strict || findings.length === 0),
        errors,
        findings,
        normalized: {
          title: plan.title,
          preset: plan.preset,
          width: plan.width,
          height: plan.height,
          fps: plan.fps,
          quality: plan.quality,
          sceneCount: plan.scenes.length,
          estimatedDuration: Number(estimatedDuration(plan.scenes).toFixed(3)),
          subtitleSource: plan.subtitles.enabled ? plan.subtitles.source : null,
        },
      }
    },

    /**
     * Report the exact timeline length and every boundary overlap.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the duration breakdown.
     */
    async duration(args, context) {
      const plan = planFrom(args, context.cwd)
      return {
        estimatedDuration: Number(estimatedDuration(plan.scenes).toFixed(3)),
        sceneCount: plan.scenes.length,
        sumOfScenes: Number(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0).toFixed(3)),
        perScene: plan.scenes.map((scene, index) => ({
          id: scene.id,
          duration: scene.duration,
          transition: scene.transition.type,
          effectiveOverlap: Number(effectiveOverlap(plan.scenes, index).toFixed(3)),
        })),
      }
    },

    /**
     * Return the packaged field reference.
     * @returns {object} the reference document.
     */
    fields() {
      return { version: 1, text: fieldReference() }
    },

    /**
     * Report objective problems with a plan, without judging its content.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the findings.
     */
    async diagnose(args, context) {
      const plan = planFrom(args, context.cwd)
      const missing = missingFiles(plan, existsSync)
      const findings = await diagnoseFindings(plan, config)
      return {
        ok: args.strict ? missing.length === 0 && findings.length === 0 : missing.length === 0,
        missingFiles: missing,
        findings,
        sceneCount: plan.scenes.length,
        estimatedDuration: Number(estimatedDuration(plan.scenes).toFixed(3)),
      }
    },
  }
}
