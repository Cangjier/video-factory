/**
 * Public surface of the deterministic core.
 *
 * The core knows nothing about DSH: it takes plain arguments and returns plain
 * data. That boundary is what makes the deterministic claims testable offline, and
 * it is why {@link module:video-factory/tools} is the only layer that imports the
 * plugin context.
 *
 * @module video-factory/core
 */
export { PLUGIN_ROOT, resolveCwd, resolveBinary, versionOf, capabilitiesOf, vendoredBuild, fontDirectories } from './env.mjs'

export {
  FFmpegError,
  FFmpegNotFound,
  fileExists,
  probeBinaries,
  resetToolCache,
  resolveTool,
  run,
  runProbe,
} from './ffmpeg.mjs'

export { ProbeError, classify, isStill, parseRational, probe, probeMany, rotationOf, streamProblems } from './probe.mjs'

export {
  ANCHORS,
  FIT_TYPES,
  MOTION_TYPES,
  PLAN_VERSION,
  PRESETS,
  PlanError,
  QUALITY,
  SCENE_KINDS,
  TRANSITION_TYPES,
  effectiveOverlap,
  estimatedDuration,
  fieldReference,
  loadPlan,
  loadResolvedPlan,
  missingFiles,
  parsePlan,
  resolvePlanPaths,
  transitionOffsets,
} from './plan.mjs'

export {
  FilterError,
  MOTION_SUPERSAMPLE,
  anchorExpressions,
  applyOverlays,
  atempoChain,
  fitFilters,
  motionFilters,
  overlayFilter,
  subtitleStyle,
  toAssColor,
  toFfmpegColor,
} from './filter.mjs'

export {
  DUPLICATE_DISTANCE,
  MaterialError,
  collectFiles,
  describe as describeInventory,
  differenceHash,
  hammingDistance,
  inventoryToJson,
  scan,
} from './materials.mjs'

export { SENTENCE_END, formatSrt, formatTimestamp, parseSrt, scaleCues, wordsToCues } from './srt.mjs'

export { ArkError, DEFAULT_BASE_URL, DEFAULT_KEY_ENV, listModels, poll, submit } from './ark.mjs'
export { generate as arkGenerate } from './ark.mjs'

export { AudioError, DEFAULT_VOICE, synthesize } from './tts.mjs'

export {
  BuildError,
  FONT_CANDIDATES,
  MAX_INTERMEDIATE_PATH,
  MEZZANINE_CRF,
  checkPathBudget,
  clipPath,
  findCjkFont,
  renderScene,
  sceneArguments,
  stageFont,
  stageOverlayText,
} from './scene.mjs'

export { assemble, timelinePath } from './assemble.mjs'
export { finalize, stageSubtitles } from './finalize.mjs'
export { MIN_PLAUSIBLE_BYTES, deliver, extractFrame, verifyAgainstPlan } from './deliver.mjs'
export { build, normalizeScenes } from './pipeline.mjs'
