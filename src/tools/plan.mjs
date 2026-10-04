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
