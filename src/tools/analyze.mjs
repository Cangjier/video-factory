/**
 * `video_analyze` — find out what is actually in a video before deciding what to do with it.
 *
 * Two questions about the picture:
 *
 * - **Which moments matter.** Hand-picking frames with `-ss` misses the cut that mattered and
 *   wastes the budget on a static stretch. {@link module:video-factory/core/sampling} scores
 *   every decoded frame against its predecessor, so a cut or a burst of movement selects
 *   itself, and each chosen frame carries the reason it was chosen.
 * - **What can be cut out of it.** The matting model separates a subject from a backdrop that is
 *   not a flat colour, one frame per call so the cost of each is visible.
 *
 * Neither action decides anything: they report moments, scores and masks. Choosing the order and
 * the pacing stays with DSH.
 *
 * What the soundtrack *is* used to be answered here too. That capability moved to the separate
 * `dsh-video-audio` plugin: `audio_measure {action:"audio_events"}` classifies a soundtrack into
 * AudioSet's 521 classes, and `audio_measure {action:"speech_map"}` finds the pauses.
 *
 * @module video-factory/tools/analyze
 */
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

export const ANALYZE_TOOL_NAME = 'video_analyze'

/** The sampling policies, mirroring `core/sampling.mjs`. */
const SAMPLE_STRATEGIES = ['adaptive', 'uniform', 'scene_change', 'motion_aware']

export function createAnalyzeTool(actions) {
  return defineFamilyTool({
    name: ANALYZE_TOOL_NAME,
    actions: ['sample_frames', 'matte', 'matte_status'],
    extraProperties: {
      target: {
        type: 'string',
        description: 'sample_frames / matte: the file to analyse. matte also accepts a still image.',
      },
      strategy: {
        type: 'string',
        enum: SAMPLE_STRATEGIES,
        description:
          'sample_frames: "adaptive" (default) keeps a frame on either a scene cut or motion; "uniform" ignores scores and keeps a fixed cadence; "scene_change" only cuts; "motion_aware" only movement.',
      },
      probeFps: {
        type: 'number',
        description:
          'sample_frames: frames per second decoded for scoring. Higher finds shorter events and costs more; default 4, at most 30. Scores are only comparable between runs that use the same probeFps and probe size.',
      },
      targetFps: {
        type: 'number',
        description:
          'sample_frames: the cadence a quiet stretch falls back to, in frames kept per second. Default 1. Lower means fewer filler frames and more reliance on the score.',
      },
      sceneThreshold: {
        type: 'number',
        description:
          'sample_frames: mean absolute luma difference (0-255) that counts as a cut. Default 30. This is a hard cut detector, not a taste filter.',
      },
      motionThreshold: {
        type: 'number',
        description:
          'sample_frames: mean absolute luma difference that counts as movement worth sampling. Default 5. Lower catches slower pans and also more noise.',
      },
      minFps: {
        type: 'number',
        description: 'sample_frames: floor on the kept cadence — a frame is always kept this often. Default 0.25.',
      },
      maxFps: {
        type: 'number',
        description: 'sample_frames: ceiling on the kept cadence, so a busy shot cannot flood the result. Default 4.',
      },
      maxFrames: {
        type: 'number',
        description: 'sample_frames: hard cap on kept frames. Default 2000.',
      },
      maxSide: {
        type: 'number',
        description:
          'sample_frames: long side in pixels of an extracted JPEG. Default 640. Keep it small: every extracted frame is an image someone has to look at.',
      },
      extract: {
        type: 'boolean',
        description:
          'sample_frames: also write the chosen frames as JPEGs and return their paths, so they can be read as images. Off by default.',
      },
      outDir: {
        type: 'string',
        description: 'sample_frames: where extracted JPEGs go. Defaults to tmp/frames beside the plugin.',
      },
      at: {
        type: 'number',
        description:
          'matte: the second of the video to cut out. Omit it to treat "target" as a still image. One frame per call on purpose — about two seconds of compute each.',
      },
      feather: {
        type: 'number',
        description:
          'matte: blur the mask edge by this many pixels before compositing. Default 0. A hard model edge on a new background reads as a cut-out sticker; 1–3 reads as a photograph.',
      },
      keepMask: {
        type: 'boolean',
        description: 'matte: keep the intermediate greyscale mask beside the PNG. Default false.',
      },
      name: {
        type: 'string',
        description: 'matte: output file stem. Default "matte".',
      },
      duration: {
        type: 'number',
        description:
          'matte_status: the video length whose matte cost should be estimated at several mask rates. (For "classify only this many seconds of the soundtrack" the action is audio_measure {action:"audio_events"} in dsh-video-audio.)',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
