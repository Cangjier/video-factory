/**
 * `video_env` — environment self-check, canvas presets, material inventory.
 *
 * The read-only half of provisioning. The actions answer "can I work here at all?", "what
 * shapes can I produce?" and "what raw material do I have?". None of them decide anything:
 * `scan` reports duplicates as facts and never drops them, because which still to use is a
 * creative choice that belongs to DSH. Installing things is `video_setup`.
 *
 * The prose the model reads is derived from `registry.mjs`; this module declares only the
 * arguments and the handlers.
 *
 * @module video-factory/tools/env
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const ENV_TOOL_NAME = 'video_env'

/** Every action this family exposes, in dispatch order. */
export const ENV_ACTIONS = ['probe', 'presets', 'scan']

export function createEnvTool(actions) {
  return defineFamilyTool({
    name: ENV_TOOL_NAME,
    actions: ENV_ACTIONS,
    extraProperties: {
      root: { type: 'string', description: 'scan: material folder to inventory. Required.' },
      recursive: { type: 'boolean', description: 'scan: descend into subdirectories. Defaults to true.' },
      dedupe: {
        type: 'boolean',
        description:
          'scan: compute perceptual hashes and mark near-duplicate stills. Defaults to true. Duplicates are reported via "duplicateOf", never removed.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
