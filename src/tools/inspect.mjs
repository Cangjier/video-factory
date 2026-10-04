/**
 * `video_inspect` — what a delivered file actually is, and whether it is what the plan asked for.
 *
 * `verify` is the check that decides whether a delivery is clean: an empty `problems` array means
 * the finished file matches the plan. Anything non-empty must be translated to the user rather
 * than hidden, which is why the render tool description points here.
 *
 * `ocr` and `find_text` used to be here, on the reasoning that they answer the same kind of
 * question as `media` — what is actually in this file. They are now their own plugin (`dsh-ocr`,
 * tools `text_read` / `text_find` / `text_setup`), because recognising text needs an OCR engine,
 * an install path and a coordinate space, none of which a video pipeline should carry. This
 * plugin renders; that one reads.
 *
 * @module video-factory/tools/inspect
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const INSPECT_TOOL_NAME = 'video_inspect'

/** Every action this family exposes, in dispatch order. */
export const INSPECT_ACTIONS = ['verify', 'media']

/**
 * Build the `video_inspect` tool definition.
 *
 * @param {Record<string, Function>} handlers - action implementations.
 * @returns {object} a raw tool definition.
 */
export function createInspectTool(handlers) {
  return defineFamilyTool({
    name: INSPECT_TOOL_NAME,
    actions: INSPECT_ACTIONS,
    extraProperties: {
      plan: { type: 'string', description: 'verify: path to the plan the file was rendered from.' },
      planData: { type: 'object', additionalProperties: true, description: 'verify: an inline plan document.' },
      target: {
        type: 'string',
        description: 'verify / media: the file to inspect, typically out/final.mp4.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'media: several files to probe in one call.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers,
  })
}
