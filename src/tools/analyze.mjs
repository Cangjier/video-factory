/**
 * `video_analyze` — find out what is actually in a video before deciding what to do with it.
 *
 * Two questions the plugin could not previously answer:
 *
 * - **Which moments matter.** Hand-picking frames with `-ss` misses the cut that mattered and
 *   wastes the budget on a static stretch. {@link module:video-factory/core/sampling} scores
 *   every decoded frame against its predecessor, so a cut or a burst of movement selects
 *   itself, and each chosen frame carries the reason it was chosen.
 * - **What it sounds like.** Transcription covers speech. Music, ambience, and sound effects
 *   are classified into AudioSet's 521 acoustic classes, which is what tells a cut whether it
 *   landed on the beat.
 *
 * Neither action decides anything: they report moments, scores, and labels. Choosing the order
 * and the pacing stays with DSH.
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
    description:
      'Find out what a video contains before editing it: which moments are worth looking at, and what its soundtrack actually is. Both actions report measurements and never choose for you.',
    actionsHelp:
      'sample_frames: score every decoded frame against its predecessor and return the moments worth a look, each with the reason it was picked (scene_change / motion / periodic / max_interval_fallback), its sceneScore, and its timestamp. Optionally writes those frames as JPEGs so they can be read as images. ' +
      'audio_events: classify the soundtrack into AudioSet\'s 521 acoustic classes with per-segment timestamps — how you find out where music starts, or that a stretch is silence, which transcription cannot tell you. ' +
      'audio_status: report whether the audio classifier is installed and what it can do, without analysing anything.',
    actions: ['sample_frames', 'audio_events', 'audio_status'],
    extraProperties: {
      target: {
        type: 'string',
        description: 'sample_frames / audio_events: the video (or audio file) to analyse.',
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
      start: {
        type: 'number',
        description: 'audio_events: analyse only from this second onwards.',
      },
      duration: {
        type: 'number',
        description: 'audio_events: analyse only this many seconds. Use with start to walk a long file in pieces.',
      },
      topK: {
        type: 'number',
        description: 'audio_events: how many labels to keep per segment. Default 3.',
      },
      minScore: {
        type: 'number',
        description: 'audio_events: score below which a label is dropped entirely. Default 0.1.',
      },
      silenceRms: {
        type: 'number',
        description:
          'audio_events: segments quieter than this root-mean-square level are reported as silent instead of classified. Default 0.002.',
      },
      includeSegments: {
        type: 'boolean',
        description:
          'audio_events: include the per-segment labels in the result. Default true; set false for just the grouped label-to-timestamps map.',
      },
      cwd: CWD_PROPERTY,
    },
    handlers: actions,
  })
}
