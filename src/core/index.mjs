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

export {
  AUTO_TARGET_LONG_SIDE,
  DEFAULT_MAX_SIDE_LEN,
  DEFAULT_MIN_SCORE as OCR_DEFAULT_MIN_SCORE,
  DEFAULT_TIMEOUT_MS,
  ENGINES,
  IDLE_SHUTDOWN_MS,
  OCR_SCRIPT,
  OCR_TMP_DIR,
  OCR_VENDOR_DIR,
  OcrError,
  asciiJson,
  describeEngineCode,
  disposeOcrSessions,
  engineState,
  findLines,
  normaliseEngineResult,
  normaliseText,
  ocrReport,
  parseRegion,
  prepareImage,
  preprocessFilter,
  readText,
  recogniseImage,
  recogniseViaWinRT,
  resolveOcrEngine,
  resolveScale,
  winrtArguments,
} from './ocr.mjs'

export {
  DEFAULT_OCR_SOURCE,
  OCR_ARCHIVE,
  OCR_MANIFEST,
  OCR_SEVEN_ZIP,
  OCR_SOURCES,
  SEVEN_ZIP,
  ensureSevenZip,
  extractArchive,
  installOcr,
  ocrInstallState,
  preferredSourceId,
  pruneLanguages,
  readManifest,
  removeOcr,
} from './ocr-install.mjs'

export {
  MAX_PROBE_FPS,
  MAX_PROBE_PIXELS,
  SAMPLE_STRATEGIES,
  SAMPLING_DEFAULTS,
  SELECTION_REASONS,
  SamplingError,
  decodeLuma,
  meanAbsoluteDifference,
  normaliseSamplingOptions,
  sampleFrames,
  scoreFrames,
  selectFrames,
} from './sampling.mjs'

export {
  AUDIO_MANIFEST,
  AUDIO_TMP_DIR,
  AUDIO_VENDOR_DIR,
  AudioEventError,
  DEFAULT_MIN_SCORE as AUDIO_DEFAULT_MIN_SCORE,
  DEFAULT_SILENCE_RMS,
  DEFAULT_TOP_K,
  MAX_AUDIO_SECONDS,
  ORT_WASM_BINARY,
  ORT_WASM_ENTRY,
  YAMNET_CLASS_MAP,
  YAMNET_HOP,
  YAMNET_MODEL,
  YAMNET_SAMPLE_RATE,
  YAMNET_WINDOW,
  audioEventState,
  classifySamples,
  decodeWav,
  detectAudioEvents,
  disposeAudioSession,
  extractAudio,
  groupEvents,
  loadSession,
  readAudioManifest,
  readClassMap,
  rms,
  topLabels,
  windowsOf,
} from './audio-events.mjs'

export {
  AUDIO_MODEL,
  AUDIO_RUNTIME_PACKAGES,
  AUDIO_SCRATCH_DIR,
  audioInstallState,
  extractRuntimePackage,
  installAudio,
  removeAudio,
  runtimePackageDir,
  sha256File,
  sriOf,
  vendoredAudioFiles,
  verifyInstalledAudio,
  writeAudioManifest,
} from './audio-install.mjs'

export {
  DEFAULT_MASK_FPS,
  MATTE_MODEL,
  MATTE_MODEL_SPEC,
  MATTE_SIDE,
  MATTE_TMP_DIR,
  MATTE_VENDOR_DIR,
  MAX_MASKS,
  MAX_MASK_FPS,
  MatteError,
  decodeToTensor,
  disposeMatteSession,
  durationOf as matteDurationOf,
  loadMatteSession,
  maskStatistics,
  matteFrame,
  matteImage,
  matteState,
  matteVideo,
  normaliseMask,
  planMasks,
  writeMaskPng,
} from './matte.mjs'

export {
  MATTE_MANIFEST,
  MATTE_SCRATCH_DIR,
  installMatte,
  matteInstallState,
  removeMatte,
  sha256File as sha256OfMatte,
  verifyInstalledMatte,
  writeMatteManifest,
} from './matte-install.mjs'
