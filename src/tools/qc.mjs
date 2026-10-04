/**
 * `video_qc` — the acceptance suite for a finished video.
 *
 * The renderer's own `video_inspect {action:"verify"}` answers one question: does this file
 * match the plan it was rendered from, on the four facts a build can break silently
 * (resolution, frame rate, duration, presence of audio). That is the smoke test. This family is
 * the test suite: named cases, each with an expectation from the plan or from a case file, each
 * returning a verdict and the measurement behind it, across the domains a viewer notices —
 * container, picture, sound, narration timing, and the delivered side files.
 *
 * Reading the burned-in subtitles back off the picture used to be a case and an action here. It
 * is `text_read {action:"verify"}` in the separate dsh-ocr plugin now, because it needs an OCR
 * engine, and this plugin no longer carries one.
 *
 * Two properties are deliberate:
 *
 * - **Every case is deterministic.** The measurements are ffmpeg's, the sampling rate is fixed,
 *   the thresholds are documented and echoed. The same file and the same case file produce the
 *   same verdicts.
 * - **A case that cannot be judged says so.** `skip` with a reason is a verdict; a green report
 *   that quietly skipped the checks it could not run is the failure mode this design avoids.
 *
 * @module video-factory/tools/qc
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action this family exposes. */
export const QC_ACTIONS = ['cases', 'check', 'structure', 'picture']

export const QC_TOOL_NAME = 'video_qc'

/**
 * Build the `video_qc` tool definition.
 * @param {Record<string, Function>} actions - one handler per action.
 * @returns {object} the tool definition.
 */
export function createQcTool(actions) {
  return defineFamilyTool({
    name: QC_TOOL_NAME,
    actions: QC_ACTIONS,
    extraProperties: {
      target: {
        type: 'string',
        description: 'check / structure / picture: the delivered file to inspect.',
      },
      plan: {
        type: 'string',
        description:
          'check: the plan.json the file was rendered from. Without it, every case whose expectation comes from the plan is skipped with that reason instead of passing.',
      },
      casesPath: {
        type: 'string',
        description:
          'cases / check: a JSON case file, `{ "cases": { "<case id>": { "severity": "warn", "enabled": false, ... } } }`. It retunes the catalogue; it cannot add a judgement the catalogue does not have.',
      },
      only: {
        type: 'array',
        items: { type: 'string' },
        description: 'check: run only these case ids (see action "cases").',
      },
      skip: {
        type: 'array',
        items: { type: 'string' },
        description: 'check: drop these case ids.',
      },
      strict: {
        type: 'boolean',
        description: 'check: treat a failed warning as a failure too. Default false: warnings are reported, not fatal.',
      },
      picture: {
        type: 'boolean',
        description: 'check: take the picture measurements. Default true; false skips the picture cases with a reason.',
      },
      reportPath: {
        type: 'string',
        description: 'check: also write the full result (verdicts plus measurements) to this JSON file.',
      },
      thresholds: {
        type: 'object',
        additionalProperties: true,
        description:
          'check: per-run threshold overrides, for example { "loudnessToleranceLu": 1.5, "maxBlackRunSeconds": 1.5 }. Unknown keys are ignored and the resolved set is echoed in the result.',
      },
      probeFps: {
        type: 'number',
        description:
          'picture: frames sampled per second of video for the black/frozen/bar measurements. Default 2. Higher finds shorter events and costs more decode time.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
