/**
 * `video_inspect` — quality control.
 *
 * `verify` is the check that decides whether a delivery is clean: an empty
 * `problems` array means the finished file matches the plan. Anything non-empty
 * must be translated to the user rather than hidden, which is why the render tool
 * description points here.
 *
 * @module video-factory/tools/inspect
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const INSPECT_TOOL_NAME = 'video_inspect'

export function createInspectTool(actions) {
  return defineFamilyTool({
    name: INSPECT_TOOL_NAME,
    description:
      'Inspect media and check a finished video against its plan. Use "verify" as the last step of every delivery: an empty problems array is the only clean result.',
    actionsHelp:
      'verify: compare a rendered file with its plan — resolution, frame rate, duration within tolerance, presence of an audio track, pixel format, and a minimum size. Returns {ok, problems}. ' +
      'media: stream metadata for any image, video, or audio file, several at once if you like.',
    actions: ['verify', 'media'],
    extraProperties: {
      plan: { type: 'string', description: 'verify: path to the plan the file was rendered from.' },
      planData: { type: 'object', additionalProperties: true, description: 'verify: an inline plan document.' },
      target: { type: 'string', description: 'verify / media: the file to inspect, typically out/final.mp4.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'media: several files to probe in one call.' },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
