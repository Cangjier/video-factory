/**
 * `video_plan` — the deterministic half of plan.json handling.
 *
 * This tool validates a plan; it never writes one. Drafting a plan means choosing
 * scenes, order, and pacing, which is exactly the creative work that belongs to
 * DSH. `check` either passes or lists problems, it never "fixes" anything:
 * `normalized` only fills in defaults the plan omitted.
 *
 * @module video-factory/tools/plan
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const PLAN_TOOL_NAME = 'video_plan'

export function createPlanTool(actions) {
  return defineFamilyTool({
    name: PLAN_TOOL_NAME,
    description:
      'Validate and inspect an edit plan (plan.json) without rendering it. You write the plan; this tool only tells you whether it is legal, how long it will run, and what is objectively wrong with it.',
    actionsHelp:
      'check: structural validation plus referenced-file existence, unique scene ids, and value ranges, reported as errors and warnings with the offending field named. ' +
      'duration: exact timeline length including transition overlap, plus the effective overlap at each boundary. ' +
      'fields: the full plan.json field reference. ' +
      'diagnose: objective problems only — a referenced file that does not exist, a still with motion "none", a transition longer than half its scene, a portrait plan full of landscape stills, a total length that misses the narration by a wide margin. ' +
      'It reports facts, never taste: it will not suggest reordering or re-timing.',
    actions: ['check', 'duration', 'fields', 'diagnose'],
    extraProperties: {
      plan: { type: 'string', description: 'Path to plan.json. Give either plan or planData.' },
      planData: {
        type: 'object',
        additionalProperties: true,
        description: 'An inline plan document, for checking a plan before writing it to disk.',
      },
      strict: { type: 'boolean', description: 'check / diagnose: treat warnings as failures.' },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
