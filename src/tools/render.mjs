/**
 * `video_render` — the ffmpeg execution layer.
 *
 * The four pipeline stages are exposed separately on purpose. `scene` is the
 * expensive, retryable step and also the uniformity operator: it is what makes
 * every clip share a canvas, frame rate, pixel format, time base, and an audio
 * track of exactly the scene's length. Once that contract holds, `assemble` can
 * safely use the concat demuxer or chain xfade, and `finalize` re-encodes the
 * picture at most once.
 *
 * Every stage caches on a fingerprint of the plan fields it depends on, so
 * changing a subtitle style re-runs only finalize, and changing one scene re-runs
 * only that scene. `force` exists to override the fingerprint, not to make
 * caching work.
 *
 * @module video-factory/tools/render
 */
import { CWD_PROPERTY, FORCE_PROPERTY, defineFamilyTool } from './shared.mjs'

export const RENDER_TOOL_NAME = 'video_render'

export function createRenderTool(actions) {
  return defineFamilyTool({
    name: RENDER_TOOL_NAME,
    actions: ['scene', 'assemble', 'finalize', 'deliver', 'build'],
    extraProperties: {
      plan: { type: 'string', description: 'Path to plan.json. Give either plan or planData.' },
      planData: { type: 'object', additionalProperties: true, description: 'An inline plan document.' },
      sceneId: { type: 'string', description: 'scene: render only this scene id, for example "s03".' },
      outDir: { type: 'string', description: 'Directory for final.mp4, cover.jpg, contact-sheet.jpg, build-report.json. Defaults to plan.json\'s "output" sibling.' },
      workDir: { type: 'string', description: 'Scratch directory for intermediates. Defaults to <outDir>/.work.' },
      clips: { type: 'array', items: { type: 'string' }, description: 'assemble: explicit clip list. Defaults to the normalized clips in plan order.' },
      timeline: { type: 'string', description: 'finalize / deliver: the assembled timeline. Defaults to <workDir>/timeline.mp4.' },
      quality: { type: 'string', enum: ['high', 'medium', 'draft'], description: 'Override meta.quality for the delivered file.' },
      force: FORCE_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
