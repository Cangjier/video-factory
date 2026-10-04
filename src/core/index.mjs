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
  ANALYSIS_SAMPLE_RATE,
  AudioMeasureError,
  DEFAULT_WINDOW_SECONDS,
  MAX_PCM_BYTES,
  MEASURE_DEFAULTS,
  SPECTRUM_SAMPLE_RATE,
  TILT_BANDS,
  decodePcm,
  describeAudio,
  identifyAudio,
  measureLevels,
  measureLoudness,
  measureNoise,
  measureSilences,
  parseAstats,
  parseEbur128,
  parseFfmpegInput,
  runAstats,
  runAudio,
  scanPcm,
  sniffContainer,
  sniffContainerBytes,
} from './audio-measure.mjs'

// The signal arithmetic stays, because the audio quality checks in `qc.mjs` measure the delivered
// film's soundtrack with it: loudness, levels, clipping runs and the silence map are part of
// verifying a video, not part of producing audio. Everything that *produces* audio — tone, build,
// restore, record, and every model-backed action — moved to the `dsh-video-audio` plugin.
export {
  amplitudeFromDb,
  bandwidthOf,
  clipRuns,
  crestFactorDb,
  dbFromAmplitude,
  dcOffsetOf,
  envelopeDb,
  envelopeLag,
  fftInPlace,
  float32FromBuffer,
  goertzelAmplitude,
  goertzelDb,
  linearFit,
  loudestChannel,
  peakOf,
  refineLag,
  rmsOf,
  spectrumOf,
  tiltOf,
  tonalPeaks,
} from './audio-signal.mjs'





export {
  CASE_CATALOGUE,
  COMPARATORS,
  PLACEHOLDER_PATTERNS,
  QC_DEFAULTS,
  QC_SEVERITIES,
  QcError,
  caseIds,
  collectAudio,
  collectFiles as collectDeliveryFiles,
  collectPicture,
  collectStructure,
  describeVerdict,
  detectBars,
  findPlaceholders,
  findRuns,
  formExpectation,
  formatCaseLine,
  formatQcReport,
  frameDifference,
  judgeCase,
  meanLuma,
  readCaseOverrides,
  readNarrationTimings,
  runQc,
  scanMp4Boxes,
  selectCases,
  streamDurations,
} from './qc.mjs'

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
