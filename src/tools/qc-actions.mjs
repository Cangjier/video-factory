/**
 * `video_qc` actions: the suite, its evidence, and the report.
 *
 * The handlers resolve paths, load the plan and the case file, and hand everything to the core.
 * They add no judgement of their own: if the core says a case passed or was skipped, that is
 * what the caller is told.
 *
 * @module video-factory/tools/qc-actions
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  CASE_CATALOGUE,
  QC_DEFAULTS,
  QcError,
  caseIds,
  collectPicture,
  collectStructure,
  formatQcReport,
  readCaseOverrides,
  runQc,
} from '../core/qc.mjs'
import { PlanError, loadResolvedPlan } from '../core/plan.mjs'
import { VideoFactoryError } from './shared.mjs'

/** How many silence entries a check result may carry before it stops listing them. */
const MAX_LISTED_SILENCES = 25

/**
 * Build the `video_qc` action table.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {Record<string, Function>} action handlers.
 */
export function createQcActions(config, logger) {
  /** Resolve a required input file. */
  const requireFile = (value, cwd, action, field) => {
    if (typeof value !== 'string' || value === '') {
      throw new VideoFactoryError(`video_qc ${action}: 需要 "${field}"。`)
    }
    const path = resolve(cwd, value)
    if (!existsSync(path)) throw new VideoFactoryError(`video_qc ${action}: 找不到文件 ${path}`)
    return path
  }

  /** Load the plan when one was named, with an actionable error when it is malformed. */
  const loadPlan = (value, cwd) => {
    if (typeof value !== 'string' || value === '') return { plan: null, planPath: null }
    const planPath = requireFile(value, cwd, 'check', 'plan')
    try {
      return { plan: loadResolvedPlan(planPath), planPath }
    } catch (error) {
      if (error instanceof PlanError) throw new VideoFactoryError(`video_qc check: 计划文件不可用：${error.message}`)
      throw error
    }
  }

  /** Load the case file when one was named. */
  const loadCases = (value, cwd) => {
    if (typeof value !== 'string' || value === '') return { overrides: new Map(), document: null, casesPath: null }
    const casesPath = requireFile(value, cwd, 'check', 'casesPath')
    let document
    try {
      document = JSON.parse(readFileSync(casesPath, 'utf8'))
    } catch (error) {
      throw new VideoFactoryError(`video_qc check: 用例文件不是合法 JSON：${error.message}`)
    }
    return { overrides: readCaseOverrides(document), document, casesPath }
  }

  /** Keep a measurement payload readable: the verdicts matter, the twentieth silence does not. */
  const compactMeasurements = (measurements) => {
    const audio = measurements.audio
    return {
      ...measurements,
      audio:
        audio === null
          ? null
          : {
              ...audio,
              silences: {
                ...audio.silences,
                silence: audio.silences.silence.slice(0, MAX_LISTED_SILENCES),
                speech: audio.silences.speech.slice(0, MAX_LISTED_SILENCES),
                listedLimit: MAX_LISTED_SILENCES,
              },
            },
    }
  }

  const guard = (action, error) => {
    if (error instanceof QcError) return new VideoFactoryError(`video_qc ${action}: ${error.message}`)
    return error
  }

  return {
    /**
     * List every case that can run.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the catalogue.
     */
    async cases(args, context) {
      const { overrides, casesPath } = loadCases(args.casesPath, context.cwd)
      const cases = CASE_CATALOGUE.map((definition) => ({
        id: definition.id,
        category: definition.category,
        title: definition.title,
        severity: overrides.get(definition.id)?.severity ?? definition.severity,
        compares: definition.compares,
        needs: definition.needs,
        enabled: overrides.get(definition.id)?.enabled !== false,
        overrides: overrides.get(definition.id) ?? null,
      }))
      return {
        action: 'cases',
        count: cases.length,
        ids: caseIds(),
        cases,
        defaults: QC_DEFAULTS,
        casesPath,
        note:
          '用例文件形如 {"cases":{"<id>":{"severity":"warn","enabled":false,"…阈值…"}}}；' +
          '它只能调整目录里的用例，不能新增判断。未给 plan 时，依赖计划的用例会以 skip 报出原因，而不是默默通过。',
      }
    },

    /**
     * Run the suite against one delivered file.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} the verdicts, the counts and the report text.
     */
    async check(args, context) {
      const target = requireFile(args.target, context.cwd, 'check', 'target')
      const { plan, planPath } = loadPlan(args.plan, context.cwd)
      const { overrides, casesPath } = loadCases(args.casesPath, context.cwd)
      const thresholds = { ...(args.thresholds ?? {}) }
      if (Number.isFinite(args.probeFps)) thresholds.probeFps = args.probeFps

      try {
        const result = await runQc({
          target,
          plan,
          planPath,
          config,
          only: Array.isArray(args.only) ? args.only : undefined,
          skip: Array.isArray(args.skip) ? args.skip : undefined,
          overrides,
          strict: args.strict === true,
          thresholds,
          picture: args.picture !== false,
        })

        let reportPath = null
        if (typeof args.reportPath === 'string' && args.reportPath !== '') {
          reportPath = resolve(context.cwd, args.reportPath)
          mkdirSync(dirname(reportPath), { recursive: true })
          writeFileSync(reportPath, `${JSON.stringify({ ...result, casesPath, reportPath }, null, 2)}\n`, { encoding: 'utf8' })
        }

        const text = formatQcReport(result)
        logger.info(`video-factory: video_qc ${result.ok ? '通过' : '未通过'}（${result.counts.passed}/${result.counts.total}）`)
        return {
          action: 'check',
          ok: result.ok,
          counts: result.counts,
          strict: result.strict,
          casesPath,
          reportPath,
          failures: result.results.filter((entry) => entry.status === 'fail'),
          skipped: result.skippedReasons,
          notes: result.notes,
          text,
          measurements: compactMeasurements(result.measurements),
          thresholds: result.thresholds,
        }
      } catch (error) {
        throw guard('check', error)
      }
    },

    /**
     * Report the raw container facts.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} probe info, per-stream facts and box order.
     */
    async structure(args, context) {
      const target = requireFile(args.target, context.cwd, 'structure', 'target')
      try {
        const collected = await collectStructure(target, config)
        return {
          action: 'structure',
          target,
          container: collected.info.formatName,
          durationSeconds: collected.info.duration,
          sizeBytes: collected.info.sizeBytes,
          bitRate: collected.info.bitRate,
          width: collected.info.width,
          height: collected.info.height,
          fps: collected.info.fps,
          pixFmt: collected.info.pixFmt,
          rotation: collected.info.rotation,
          streams: collected.streams.streams,
          videoSeconds: collected.streams.videoSeconds,
          audioSeconds: collected.streams.audioSeconds,
          boxes: collected.boxes,
          note: '每流时长来自 ffprobe 的 stream；容器时长可能更长——音轨提前结束正是这样被看出来的。',
        }
      } catch (error) {
        throw guard('structure', error)
      }
    },

    /**
     * Report the raw picture facts.
     * @param {object} args - the tool arguments.
     * @param {object} context - the tool context.
     * @returns {Promise<object>} black runs, frozen runs, bars and luma statistics.
     */
    async picture(args, context) {
      const target = requireFile(args.target, context.cwd, 'picture', 'target')
      try {
        const collected = await collectPicture(target, config, {
          probeFps: Number.isFinite(args.probeFps) ? args.probeFps : undefined,
          pictureSamples: Number.isFinite(args.sampleFrames) ? args.sampleFrames : undefined,
        })
        return {
          action: 'picture',
          target,
          ...collected,
          note:
            '采样率固定，所以同一个文件两次测量的时间戳一致。黑帧=整帧均值低于阈值；冻帧=相邻采样帧逐像素完全相同；' +
            '黑边=边缘行/列既均匀又明显暗于画面中部。三者都是事实，不是评价。',
        }
      } catch (error) {
        throw guard('picture', error)
      }
    },
  }
}
