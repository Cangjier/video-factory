/**
 * Quality control: a case file the finished video has to satisfy, judged deterministically.
 *
 * The idea is the one a test suite already proved out: write the expectations down once, run
 * them against every delivery, and get back per-case verdicts with the evidence attached. Two
 * rules keep it honest:
 *
 * 1. **A case never decides what "good" means.** The expectation comes from the plan, from the
 *    case file, or from a default that is written down here and echoed in the result. The tool
 *    reports `expected`, `actual` and the delta; whether a miss matters is visible in the
 *    verdict, not hidden inside it.
 * 2. **Unanswerable is a verdict of its own.** A case whose expectation cannot be formed (no
 *    plan, no OCR engine, no narration timings) comes back `skip` with the reason, never a
 *    silent pass. A green report that skipped half its cases is the failure mode this design
 *    exists to prevent.
 *
 * The catalogue is data: each case names the measurements it needs, how to form its
 * expectation, how to read its actual value, and which comparator decides. That keeps the
 * judgement in one small set of pure functions that can be tested without touching a video.
 *
 * @module video-factory/core/qc
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { measureLevels, measureLoudness, measureSilences, describeAudio } from './audio-measure.mjs'
import { estimatedDuration } from './plan.mjs'
import { decodeLuma } from './sampling.mjs'
import { parseSrt } from './srt.mjs'
import { probe } from './probe.mjs'
import { runProbe } from './ffmpeg.mjs'

/** Raised when a quality-control run cannot be set up. */
export class QcError extends Error {
  constructor(message) {
    super(message)
    this.name = 'QcError'
  }
}

/** Every severity a case may carry. `error` fails the run; `warn` only reports. */
export const QC_SEVERITIES = ['error', 'warn']

/**
 * Every threshold this module applies when the caller supplies none.
 *
 * They are here, in one object, for one reason: a quality gate whose thresholds are hidden
 * inside the code is a gate nobody can argue with. Each one is echoed in the result.
 */
export const QC_DEFAULTS = {
  durationToleranceSeconds: 0.1,
  frameCountTolerance: 2,
  fpsTolerance: 0.02,
  loudnessToleranceLu: 1,
  truePeakCeilingDbtp: -1,
  clippingRunSamples: 3,
  dcOffsetLimit: 0.002,
  headSilenceLimitSeconds: 1,
  tailSilenceLimitSeconds: 5,
  maxBlackRunSeconds: 1,
  blackLumaThreshold: 16,
  maxFrozenRunSeconds: 3,
  frozenDifferenceThreshold: 0,
  barLimitFraction: 0.03,
  barLumaTolerance: 24,
  probeFps: 2,
  probeWidth: 160,
  probeHeight: 90,
  maxProbeFrames: 4000,
  pictureSamples: 24,
}

/** Text that should never reach a delivered frame. */
export const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bFIXME\b/i,
  /\bXXX\b/i,
  /\{\{[^}]*\}\}/,
  /\$\{[^}]*\}/,
  /lorem ipsum/i,
  /\uFFFD/,
]

/**
 * Decode the MP4 box tree far enough to say whether the file is fast-start.
 *
 * A delivered file should have its `moov` before its `mdat`: players that read over HTTP then
 * have the index before the payload, and can start without the whole file. It is a one-line
 * fact about a file that is otherwise invisible, which is exactly what a case is for.
 *
 * @param {string} path - the file to read.
 * @param {number} [maxBoxes] - stop after this many boxes; default 64.
 * @returns {{fastStart: boolean|null, boxes: Array<{type: string, size: number, at: number}>, note: string}}
 *   `null` when the file is not an ISO base media file at all.
 */
export function scanMp4Boxes(path, maxBoxes = 64) {
  const size = statSync(path).size
  const handle = openSync(path, 'r')
  const head = Buffer.alloc(16)
  try {
    readSync(handle, head, 0, head.length, 0)
    if (head.subarray(4, 8).toString('latin1') !== 'ftyp') {
      return { fastStart: null, boxes: [], note: '不是 ISO BMFF（MP4/MOV）容器，faststart 不适用。' }
    }

    const boxes = []
    let at = 0
    let fastStart = null
    while (at < size && boxes.length < maxBoxes) {
      const header = Buffer.alloc(16)
      const read = readSync(handle, header, 0, header.length, at)
      if (read < 8) break
      let boxSize = header.readUInt32BE(0)
      const type = header.subarray(4, 8).toString('latin1')
      let headerBytes = 8
      if (boxSize === 1) {
        // 64-bit size: `largesize` follows the type.
        if (read < 16) break
        boxSize = Number(header.readBigUInt64BE(8))
        headerBytes = 16
      } else if (boxSize === 0) {
        boxSize = size - at // extends to end of file
      }
      if (boxSize < headerBytes) break
      boxes.push({ type, size: boxSize, at })
      if (type === 'moov' || type === 'mdat') {
        if (type === 'moov' && fastStart === null) fastStart = true
        else if (type === 'mdat' && fastStart === null) fastStart = false
      }
      at += boxSize
    }
    return {
      fastStart,
      boxes,
      note:
        fastStart === null
          ? '顶层里既没有 moov 也没有 mdat，无法判断 faststart。'
          : fastStart
            ? 'moov 在 mdat 之前（faststart 已满足）。'
            : 'mdat 在 moov 之前：HTTP 播放要等整个文件下载完才能起播。',
    }
  } finally {
    closeSync(handle)
  }
}

/**
 * Per-stream durations, which is what catches an audio track that stops early.
 *
 * `probe()` reports the container's duration; the failure this case family was written for —
 * a soundtrack three seconds shorter than the picture — is invisible at container level and
 * obvious at stream level.
 *
 * @param {string} path - the file.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{videoSeconds: number|null, audioSeconds: number|null, streams: object[], hasVideo: boolean, hasAudio: boolean}>}
 */
export async function streamDurations(path, config = {}) {
  const document = await runProbe(
    [
      '-v', 'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,duration,nb_frames,avg_frame_rate,sample_rate,channels,bit_rate,' +
        'pix_fmt,color_range,color_primaries,color_space,sample_aspect_ratio,display_aspect_ratio,width,height',
      '-of', 'json', path,
    ],
    config,
  )
  const streams = (document.streams ?? []).map((stream) => ({
    index: Number(stream.index),
    type: stream.codec_type ?? null,
    codec: stream.codec_name ?? null,
    seconds: Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : null,
    frames: Number.isFinite(Number(stream.nb_frames)) && Number(stream.nb_frames) > 0 ? Number(stream.nb_frames) : null,
    fps: parseRational(stream.avg_frame_rate),
    sampleRate: Number(stream.sample_rate) || null,
    channels: Number(stream.channels) || null,
    bitRate: Number(stream.bit_rate) || null,
    pixFmt: stream.pix_fmt ?? null,
    colorRange: stream.color_range ?? null,
    colorPrimaries: stream.color_primaries ?? null,
    colorSpace: stream.color_space ?? null,
    sar: stream.sample_aspect_ratio ?? null,
    dar: stream.display_aspect_ratio ?? null,
    width: Number(stream.width) || null,
    height: Number(stream.height) || null,
  }))
  const video = streams.find((stream) => stream.type === 'video') ?? null
  const audio = streams.find((stream) => stream.type === 'audio') ?? null
  return {
    videoSeconds: video?.seconds ?? null,
    audioSeconds: audio?.seconds ?? null,
    streams,
    hasVideo: video !== null,
    hasAudio: audio !== null,
  }
}

/**
 * Read a frame rate written as `num/den`.
 * @param {string|undefined} value - the rational.
 * @returns {number|null} frames per second, or null.
 */
export function parseRational(value) {
  if (typeof value !== 'string' || value === '' || value === '0/0') return null
  const [numerator, denominator] = value.split('/').map(Number)
  if (!Number.isFinite(numerator)) return null
  if (denominator === undefined) return numerator
  if (!Number.isFinite(denominator) || denominator === 0) return null
  return numerator / denominator
}

/**
 * Find runs of sampled frames that satisfy a predicate.
 *
 * Pure, and the shared engine behind the black-frame and frozen-frame cases: both are "a
 * condition held for too long", and both must report where and for how long so the reader can
 * go and look at that moment.
 *
 * @param {Array<{at: number}>} frames - sampled frames in order.
 * @param {(index: number) => boolean} matches - whether frame `index` satisfies the condition.
 * @returns {Array<{fromSeconds: number, toSeconds: number, seconds: number, frames: number}>} runs.
 */
export function findRuns(frames, matches) {
  const runs = []
  let start = -1
  for (let index = 0; index < frames.length; index += 1) {
    if (matches(index)) {
      if (start < 0) start = index
      continue
    }
    if (start >= 0) {
      runs.push(runOf(frames, start, index - 1))
      start = -1
    }
  }
  if (start >= 0) runs.push(runOf(frames, start, frames.length - 1))
  return runs
}

/**
 * Turn a run of frame indices into a time range.
 * @param {Array<{at: number}>} frames - the sampled frames.
 * @param {number} from - first index of the run.
 * @param {number} to - last index of the run.
 * @returns {{fromSeconds: number, toSeconds: number, seconds: number, frames: number}} the range.
 */
function runOf(frames, from, to) {
  const fromSeconds = frames[from].at
  // The run ends one sampling interval after its last frame, so a one-frame run is not zero long.
  const interval = frames.length > 1 ? frames[1].at - frames[0].at : 0
  const toSeconds = frames[to].at + interval
  return {
    fromSeconds: Number(fromSeconds.toFixed(3)),
    toSeconds: Number(toSeconds.toFixed(3)),
    seconds: Number((toSeconds - fromSeconds).toFixed(3)),
    frames: to - from + 1,
  }
}

/**
 * Mean luma of a grayscale frame, in 0..255.
 * @param {Uint8Array} luma - the frame.
 * @returns {number} the mean.
 */
export function meanLuma(luma) {
  let sum = 0
  for (let index = 0; index < luma.length; index += 1) sum += luma[index]
  return sum / Math.max(1, luma.length)
}

/**
 * Mean absolute difference between two same-sized frames.
 * @param {Uint8Array} a - first frame.
 * @param {Uint8Array} b - second frame.
 * @returns {number} the mean difference, 0 when identical.
 */
export function frameDifference(a, b) {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index] - b[index])
  return sum / Math.max(1, a.length)
}

/**
 * Estimate letterbox or pillarbox bars from one frame.
 *
 * A bar is a band along an edge whose rows (or columns) are uniform and much darker than the
 * picture inside. Both conditions are required: a dark scene is not a bar, and a uniform
 * bright sky is not a bar either. Reported as a fraction of the frame's own dimension, so the
 * caller compares it against a limit without knowing the probe size.
 *
 * @param {Uint8Array} luma - the frame.
 * @param {number} width - frame width in pixels.
 * @param {number} height - frame height in pixels.
 * @param {object} [options] - thresholds.
 * @param {number} [options.tolerance] - how uniform a band must be, in luma units; default 24.
 * @returns {{top: number, bottom: number, left: number, right: number, note: string}}
 *   each as a fraction of the frame dimension.
 */
export function detectBars(luma, width, height, options = {}) {
  const tolerance = options.tolerance ?? QC_DEFAULTS.barLumaTolerance
  const rowMean = (y) => {
    let sum = 0
    for (let x = 0; x < width; x += 1) sum += luma[y * width + x]
    return sum / width
  }
  const rowSpread = (y) => {
    let min = 255
    let max = 0
    for (let x = 0; x < width; x += 1) {
      const value = luma[y * width + x]
      if (value < min) min = value
      if (value > max) max = value
    }
    return max - min
  }
  const columnMean = (x) => {
    let sum = 0
    for (let y = 0; y < height; y += 1) sum += luma[y * width + x]
    return sum / height
  }
  const columnSpread = (x) => {
    let min = 255
    let max = 0
    for (let y = 0; y < height; y += 1) {
      const value = luma[y * width + x]
      if (value < min) min = value
      if (value > max) max = value
    }
    return max - min
  }

  // The picture's own level: the mean of the middle half, which cannot be part of a bar.
  let interiorSum = 0
  let interiorCount = 0
  for (let y = Math.floor(height * 0.25); y < Math.ceil(height * 0.75); y += 1) {
    for (let x = Math.floor(width * 0.25); x < Math.ceil(width * 0.75); x += 1) {
      interiorSum += luma[y * width + x]
      interiorCount += 1
    }
  }
  const interior = interiorSum / Math.max(1, interiorCount)
  const isBar = (mean, spread) => spread <= tolerance && interior - mean >= tolerance

  let top = 0
  while (top < height / 2 && isBar(rowMean(top), rowSpread(top))) top += 1
  let bottom = 0
  while (bottom < height / 2 && isBar(rowMean(height - 1 - bottom), rowSpread(height - 1 - bottom))) bottom += 1
  let left = 0
  while (left < width / 2 && isBar(columnMean(left), columnSpread(left))) left += 1
  let right = 0
  while (right < width / 2 && isBar(columnMean(width - 1 - right), columnSpread(width - 1 - right))) right += 1

  return {
    top: Number((top / height).toFixed(4)),
    bottom: Number((bottom / height).toFixed(4)),
    left: Number((left / width).toFixed(4)),
    right: Number((right / width).toFixed(4)),
    note: '边缘条带：要求该行/列既均匀（极差 ≤ 容差）又明显暗于画面中部；两个条件都满足才算。',
  }
}

/**
 * Find text that should never have shipped.
 * @param {string} value - the text to inspect.
 * @returns {string[]} the patterns that matched.
 */
export function findPlaceholders(value) {
  const text = String(value ?? '')
  return PLACEHOLDER_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source)
}

/** Comparators: the only places a judgement is made, all of them arithmetic. */
export const COMPARATORS = {
  /** value must be within tolerance of target. */
  within: (actual, expected) => ({
    ok: Number.isFinite(actual) && Math.abs(actual - expected.target) <= expected.tolerance,
    delta: Number.isFinite(actual) ? Number((actual - expected.target).toFixed(4)) : null,
  }),
  /** value must be at least limit. */
  atLeast: (actual, expected) => ({
    ok: Number.isFinite(actual) && actual >= expected.limit,
    delta: Number.isFinite(actual) ? Number((actual - expected.limit).toFixed(4)) : null,
  }),
  /** value must be at most limit. */
  atMost: (actual, expected) => ({
    ok: Number.isFinite(actual) && actual <= expected.limit,
    delta: Number.isFinite(actual) ? Number((actual - expected.limit).toFixed(4)) : null,
  }),
  /** value must equal target exactly. */
  equals: (actual, expected) => ({ ok: actual === expected.target, delta: null }),
  /** every run must be no longer than limitSeconds. */
  runsAtMost: (actual, expected) => {
    const runs = Array.isArray(actual) ? actual : []
    const worst = runs.reduce((best, run) => (best === null || run.seconds > best.seconds ? run : best), null)
    return { ok: worst === null || worst.seconds <= expected.limitSeconds, delta: worst === null ? null : Number(worst.seconds.toFixed(3)) }
  },
  /** no placeholder pattern may appear. */
  clean: (actual) => ({ ok: Array.isArray(actual) && actual.length === 0, delta: null }),
}

/**
 * Form one case's expectation from the plan and the caller's overrides.
 *
 * @param {object} definition - the case definition.
 * @param {object} context - the run context, carrying `plan`, `options` and the measurements.
 * @param {object} overrides - the case file's entry for this case, if any.
 * @returns {{expected: object|null, reason: string|null}} the expectation, or why there is none.
 */
export function formExpectation(definition, context, overrides = {}) {
  if (overrides.enabled === false) return { expected: null, reason: 'case 文件里已禁用该用例。' }
  if (typeof definition.expectation !== 'function') return { expected: null, reason: '该用例没有期望值构造器。' }
  const formed = definition.expectation({ ...context, overrides })
  if (formed === null || formed === undefined) {
    return { expected: null, reason: definition.expectationReason ?? '缺少构成期望值所需的输入（通常是 plan）。' }
  }
  return { expected: formed, reason: null }
}

/**
 * Judge one case.
 *
 * @param {object} definition - the case definition from the catalogue.
 * @param {object} context - the run context with measurements.
 * @param {object} [overrides] - the case file's entry.
 * @returns {{id: string, title: string, severity: string, status: 'pass'|'fail'|'skip',
 *   expected: object|null, actual: unknown, delta: number|null, detail: string, evidence: unknown}}
 */
export function judgeCase(definition, context, overrides = {}) {
  const severity = overrides.severity ?? definition.severity
  const base = {
    id: definition.id,
    title: definition.title,
    severity,
    category: definition.category,
    compares: definition.compares,
  }

  const { expected, reason } = formExpectation(definition, context, overrides)
  if (expected === null) {
    return { ...base, status: 'skip', expected: null, actual: null, delta: null, detail: reason, evidence: null }
  }

  let actual
  try {
    actual = definition.measure(context)
  } catch (error) {
    return {
      ...base,
      status: 'skip',
      expected,
      actual: null,
      delta: null,
      detail: `测量失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      evidence: null,
    }
  }
  if (actual === null || actual === undefined) {
    return { ...base, status: 'skip', expected, actual: null, delta: null, detail: '该用例需要的测量没有取到。', evidence: null }
  }

  const comparator = COMPARATORS[definition.compares]
  if (comparator === undefined) {
    return { ...base, status: 'skip', expected, actual, delta: null, detail: `未知的比较器 ${definition.compares}`, evidence: null }
  }
  const verdict = comparator(actual, expected)
  return {
    ...base,
    status: verdict.ok ? 'pass' : 'fail',
    expected,
    actual,
    delta: verdict.delta ?? null,
    detail: verdict.ok ? '满足期望。' : definition.failureDetail === undefined ? '不满足期望。' : definition.failureDetail({ actual, expected }),
    evidence: definition.evidence === undefined ? null : definition.evidence(context, actual, expected),
  }
}

/**
 * Format the measured value the way the case's expectation is written, for the report line.
 * @param {object|null} expected - the expectation.
 * @param {unknown} actual - the measured value.
 * @param {number|null} delta - actual minus expected where that means something.
 * @returns {string} one human-readable line.
 */
export function describeVerdict(expected, actual, delta) {
  const format = (value) => {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (Array.isArray(value)) return `${value.length} 项`
    if (typeof value === 'object') return Object.entries(value).map(([key, entry]) => `${key}=${format(entry)}`).join(' ')
    return String(value)
  }
  const parts = [`期望 ${format(expected)}`, `实际 ${format(actual)}`]
  if (delta !== null && delta !== undefined && Number.isFinite(delta)) parts.push(`差 ${delta > 0 ? '+' : ''}${delta}`)
  return parts.join('，')
}

/**
 * Add the two reminder lines the tool prints beside the expectation, when the case has them.
 * @param {object} result - a judged case.
 * @returns {string} the line rendered for a report.
 */
export function formatCaseLine(result) {
  const mark = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? (result.severity === 'error' ? 'FAIL' : 'WARN') : 'SKIP'
  return `${mark} ${result.category}/${result.id} — ${describeVerdict(result.expected, result.actual, result.delta)}：${result.detail}`
}

/**
 * Measure everything the structural cases need.
 * @param {string} target - the delivered file.
 * @param {object} config - normalized plugin config.
 * @returns {Promise<object>} probe info, per-stream facts and the MP4 box order.
 */
export async function collectStructure(target, config) {
  const info = await probe(target, config)
  return { info, streams: await streamDurations(target, config), boxes: scanMp4Boxes(target) }
}

/**
 * Sample the picture and derive the facts the picture cases are about.
 *
 * Sampling is deterministic — a fixed probe rate and probe size — so two runs over the same
 * file produce the same runs, the same timestamps and the same bar fractions.
 *
 * @param {string} target - the video.
 * @param {object} config - normalized plugin config.
 * @param {object} [options] - overrides for the probe rate, size and thresholds.
 * @returns {Promise<object>} black runs, frozen runs, bar fractions and luma statistics.
 */
export async function collectPicture(target, config, options = {}) {
  const blackLumaThreshold = options.blackLumaThreshold ?? QC_DEFAULTS.blackLumaThreshold
  const frozenDifferenceThreshold = options.frozenDifferenceThreshold ?? QC_DEFAULTS.frozenDifferenceThreshold
  const decoded = await decodeLuma(target, {
    probeFps: options.probeFps ?? QC_DEFAULTS.probeFps,
    probeWidth: options.probeWidth ?? QC_DEFAULTS.probeWidth,
    probeHeight: options.probeHeight ?? QC_DEFAULTS.probeHeight,
    maxFrames: options.maxFrames ?? QC_DEFAULTS.maxProbeFrames,
    config,
  })

  const frames = decoded.frames
  const lumas = frames.map((frame) => meanLuma(frame.luma))
  const blackRuns = findRuns(frames, (index) => lumas[index] <= blackLumaThreshold)
  const frozenRuns = findRuns(frames, (index) => index > 0 && frameDifference(frames[index - 1].luma, frames[index].luma) <= frozenDifferenceThreshold)

  // Bars are looked for on an evenly spread subset: one frame in a letterboxed delivery has
  // them all, and the worst frame is the one worth reporting.
  const sampleCount = Math.max(1, Math.min(options.pictureSamples ?? QC_DEFAULTS.pictureSamples, frames.length))
  const worst = { top: 0, bottom: 0, left: 0, right: 0, at: null }
  for (let index = 0; index < sampleCount; index += 1) {
    const frameIndex = sampleCount === 1 ? 0 : Math.round((index * (frames.length - 1)) / (sampleCount - 1))
    const bars = detectBars(frames[frameIndex].luma, decoded.width, decoded.height, { tolerance: options.barLumaTolerance })
    const worstEdge = Math.max(bars.top, bars.bottom, bars.left, bars.right)
    if (worstEdge > Math.max(worst.top, worst.bottom, worst.left, worst.right)) {
      worst.top = bars.top
      worst.bottom = bars.bottom
      worst.left = bars.left
      worst.right = bars.right
      worst.at = frames[frameIndex].at
    }
  }

  return {
    probeFps: decoded.fps,
    width: decoded.width,
    height: decoded.height,
    sampledFrames: frames.length,
    luma: {
      mean: Number((lumas.reduce((sum, value) => sum + value, 0) / Math.max(1, lumas.length)).toFixed(2)),
      darkest: Number(Math.min(...lumas).toFixed(2)),
      brightest: Number(Math.max(...lumas).toFixed(2)),
    },
    blackLumaThreshold,
    blackRuns,
    frozenDifferenceThreshold,
    frozenRuns,
    bars: { ...worst, note: '取采样帧里最严重的一帧；fraction 是相对画面自身尺寸的比例。' },
  }
}

/**
 * Measure the soundtrack: loudness, sample-domain levels and how much silence holds each end.
 *
 * @param {string} target - the delivered file.
 * @param {object} config - normalized plugin config.
 * @param {object} [options] - thresholds.
 * @returns {Promise<object>} the audio measurements, or null when the file has no audio.
 */
export async function collectAudio(target, config, options = {}) {
  const info = await describeAudio(target, config)
  if (!(info.channels > 0)) return null

  const loudness = await measureLoudness({ source: target, config })
  const levels = await measureLevels({
    source: target,
    config,
    timeline: false,
    maxSeconds: options.maxSeconds ?? 1800,
    clipThreshold: options.clipThreshold,
    minClipSamples: options.clippingRunSamples ?? QC_DEFAULTS.clippingRunSamples,
  })
  // The silence threshold is relative to this file's own peak: an absolute -50 dB finds nothing
  // in a quiet master and everything in a loud one, and "where does the audio start" is a
  // question about this file.
  const noiseDb = Math.max(-70, Math.min(-20, Number((levels.peakDbfs - 40).toFixed(1))))
  const silences = await measureSilences({
    source: target,
    config,
    noiseDb,
    minSeconds: options.minSilenceSeconds ?? 0.2,
  })

  const firstSpeech = silences.speech[0] ?? null
  const lastSpeech = silences.speech[silences.speech.length - 1] ?? null
  return {
    info,
    loudness,
    levels,
    silences,
    silenceThresholdDb: noiseDb,
    headSilenceSeconds: firstSpeech === null ? null : Number(firstSpeech.start.toFixed(3)),
    tailSilenceSeconds: lastSpeech === null ? null : Number((silences.durationSeconds - lastSpeech.end).toFixed(3)),
  }
}

/**
 * Read the narration timings a plan refers to: the word file beside the voiceover if there is
 * one, otherwise the subtitle cues.
 *
 * @param {object} plan - the resolved plan.
 * @returns {{source: string|null, lastEndSeconds: number|null, firstStartSeconds: number|null, count: number}}
 */
export function readNarrationTimings(plan) {
  const voiceover = plan?.audio?.voiceover ?? null
  if (typeof voiceover === 'string' && voiceover !== '') {
    const words = join(dirname(voiceover), `${voiceover.replace(/\.[^.]+$/, '').split(/[\\/]/).pop()}.words.json`)
    if (existsSync(words)) {
      try {
        const parsed = JSON.parse(readFileSync(words, 'utf8'))
        const list = Array.isArray(parsed) ? parsed : (parsed.words ?? [])
        if (list.length > 0) {
          return {
            source: words,
            firstStartSeconds: Number(list[0].start.toFixed(3)),
            lastEndSeconds: Number(list[list.length - 1].end.toFixed(3)),
            count: list.length,
          }
        }
      } catch {
        // Fall through to the subtitle cues.
      }
    }
  }

  const srt = plan?.subtitles?.source ?? null
  if (typeof srt === 'string' && srt !== '' && existsSync(srt) && /\.srt$/i.test(srt)) {
    const cues = parseSrt(readFileSync(srt, 'utf8'))
    if (cues.length > 0) {
      return {
        source: srt,
        firstStartSeconds: Number(cues[0].start.toFixed(3)),
        lastEndSeconds: Number(cues[cues.length - 1].end.toFixed(3)),
        count: cues.length,
        cues,
      }
    }
  }
  return { source: null, firstStartSeconds: null, lastEndSeconds: null, count: 0 }
}

/**
 * Look for the delivered side files beside the video.
 * @param {string} target - the delivered video.
 * @param {object} plan - the resolved plan.
 * @returns {object} what exists, with sizes and the build report's problem count.
 */
export function collectFiles(target, plan) {
  const outDir = plan?.outDir ?? dirname(target)
  const found = { outDir, cover: null, contactSheet: null, buildReport: null, problems: null, problemsTotal: null }
  for (const [key, name] of [['cover', 'cover.jpg'], ['contactSheet', 'contact-sheet.jpg']]) {
    const path = join(outDir, name)
    if (existsSync(path)) found[key] = { path, sizeBytes: statSync(path).size }
  }
  const reportPath = join(outDir, 'build-report.json')
  if (existsSync(reportPath)) {
    found.buildReport = reportPath
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      found.problems = Array.isArray(report.problems) ? report.problems : null
      found.problemsTotal = found.problems === null ? null : found.problems.length
      found.buildReportSummary = {
        plannedDuration: report.plannedDuration ?? null,
        sceneCount: report.sceneCount ?? null,
        quality: report.quality ?? null,
      }
    } catch {
      found.problems = null
    }
  }
  return found
}

/** Read the whole delivered subtitle text, for the placeholder case. */
function subtitleText(plan) {
  const srt = plan?.subtitles?.source
  if (typeof srt !== 'string' || srt === '' || !existsSync(srt)) return null
  try {
    return readFileSync(srt, 'utf8')
  } catch {
    return null
  }
}

/**
 * The case catalogue.
 *
 * `needs` names the measurements a case depends on; the runner only takes those measurements.
 * `expectation` returns null when the expectation cannot be formed, which the judge turns into
 * a `skip` with a reason rather than a pass.
 */
export const CASE_CATALOGUE = [
  {
    id: 'faststart',
    category: 'container',
    title: 'moov 在 mdat 之前（可边下边播）',
    severity: 'error',
    compares: 'equals',
    needs: ['structure'],
    expectation: () => ({ target: true }),
    measure: (context) => context.structure.boxes.fastStart,
    evidence: (context) => ({ boxes: context.structure.boxes.boxes.slice(0, 6).map((box) => box.type), note: context.structure.boxes.note }),
    failureDetail: () => 'mdat 在 moov 之前：HTTP 播放要等整个文件下载完才能起播。',
  },
  {
    id: 'one_video_stream',
    category: 'container',
    title: '恰好一条视频流',
    severity: 'error',
    compares: 'equals',
    needs: ['structure'],
    expectation: () => ({ target: 1 }),
    measure: (context) => context.structure.streams.streams.filter((stream) => stream.type === 'video').length,
  },
  {
    id: 'audio_stream_count',
    category: 'container',
    title: '音轨数量与计划一致',
    severity: 'error',
    compares: 'equals',
    needs: ['structure', 'plan'],
    expectation: (context) => ({ target: context.planHasAudio ? 1 : 0 }),
    measure: (context) => context.structure.streams.streams.filter((stream) => stream.type === 'audio').length,
    failureDetail: ({ actual, expected }) => `期望 ${expected.target} 条音轨，实际 ${actual} 条。`,
  },
  {
    id: 'width',
    category: 'video',
    title: '画面宽度等于预设画布',
    severity: 'error',
    compares: 'within',
    needs: ['structure', 'plan'],
    expectation: (context) => (context.plan === null ? null : { target: context.plan.width, tolerance: 0 }),
    measure: (context) => context.structure.info.width,
  },
  {
    id: 'height',
    category: 'video',
    title: '画面高度等于预设画布',
    severity: 'error',
    compares: 'within',
    needs: ['structure', 'plan'],
    expectation: (context) => (context.plan === null ? null : { target: context.plan.height, tolerance: 0 }),
    measure: (context) => context.structure.info.height,
  },
  {
    id: 'fps',
    category: 'video',
    title: '帧率等于计划帧率',
    severity: 'error',
    compares: 'within',
    needs: ['structure', 'plan'],
    expectation: (context) =>
      context.plan === null ? null : { target: context.plan.fps, tolerance: context.options.fpsTolerance ?? QC_DEFAULTS.fpsTolerance },
    measure: (context) => context.structure.info.fps,
  },
  {
    id: 'duration',
    category: 'video',
    title: '成片时长等于计划时长',
    severity: 'error',
    compares: 'within',
    needs: ['structure', 'plan'],
    expectation: (context) =>
      context.plan === null
        ? null
        : {
            target: Number(estimatedDuration(context.plan.scenes).toFixed(3)),
            tolerance: context.options.durationToleranceSeconds ?? QC_DEFAULTS.durationToleranceSeconds,
          },
    measure: (context) => Number(context.structure.info.duration.toFixed(3)),
    evidence: (context) => ({ plannedScenes: context.plan?.scenes.length ?? null }),
  },
  {
    id: 'frame_count',
    category: 'video',
    title: '帧数与时长×帧率一致',
    severity: 'error',
    compares: 'within',
    needs: ['structure'],
    expectation: (context) => {
      const stream = context.structure.streams.streams.find((entry) => entry.type === 'video')
      if (stream === undefined || stream.frames === null || !(stream.fps > 0)) return null
      return { target: Math.round((context.structure.info.duration - 0) * stream.fps), tolerance: context.options.frameCountTolerance ?? QC_DEFAULTS.frameCountTolerance }
    },
    measure: (context) => context.structure.streams.streams.find((entry) => entry.type === 'video')?.frames ?? null,
    failureDetail: ({ actual, expected }) => `容器声明 ${actual} 帧，时长×帧率推算 ${expected.target} 帧：两端之一在说谎（常见于冻结尾帧或被截断的封装）。`,
  },
  {
    id: 'pixel_format',
    category: 'video',
    title: '像素格式是 yuv420p',
    severity: 'error',
    compares: 'equals',
    needs: ['structure'],
    expectation: () => ({ target: 'yuv420p' }),
    measure: (context) => context.structure.info.pixFmt,
  },
  {
    id: 'color_range',
    category: 'video',
    title: '色彩范围是 tv（limited）',
    severity: 'warn',
    compares: 'equals',
    needs: ['structure'],
    expectation: () => ({ target: 'tv' }),
    measure: (context) => context.structure.streams.streams.find((entry) => entry.type === 'video')?.colorRange ?? null,
    failureDetail: ({ actual }) => `色彩范围是 ${actual}：pc 范围送进只认 tv 的播放器会把黑位抬起来。`,
  },
  {
    id: 'color_primaries',
    category: 'video',
    title: '色彩原色标记为 bt709',
    severity: 'warn',
    compares: 'equals',
    needs: ['structure'],
    expectation: () => ({ target: 'bt709' }),
    measure: (context) => context.structure.streams.streams.find((entry) => entry.type === 'video')?.colorPrimaries ?? null,
  },
  {
    id: 'sample_aspect',
    category: 'video',
    title: '像素宽高比是 1:1',
    severity: 'warn',
    compares: 'equals',
    needs: ['structure'],
    expectation: () => ({ target: '1:1' }),
    measure: (context) => context.structure.streams.streams.find((entry) => entry.type === 'video')?.sar ?? null,
    failureDetail: ({ actual }) => `像素宽高比是 ${actual}：非方形像素会让画面在部分播放器里被拉伸。`,
  },
  {
    id: 'audio_present',
    category: 'audio',
    title: '有声轨（当计划里配了声音）',
    severity: 'error',
    compares: 'equals',
    needs: ['structure', 'plan'],
    expectation: (context) => ({ target: context.planHasAudio }),
    measure: (context) => context.structure.streams.hasAudio,
  },
  {
    id: 'audio_duration_matches_picture',
    category: 'audio',
    title: '音轨时长与画面一致',
    severity: 'error',
    compares: 'within',
    needs: ['structure'],
    expectation: (context) => {
      const videoSeconds = context.structure.streams.videoSeconds
      const audioSeconds = context.structure.streams.audioSeconds
      if (videoSeconds === null || audioSeconds === null) return null
      return { target: Number(videoSeconds.toFixed(3)), tolerance: context.options.durationToleranceSeconds ?? QC_DEFAULTS.durationToleranceSeconds }
    },
    measure: (context) => {
      const audioSeconds = context.structure.streams.audioSeconds
      return audioSeconds === null ? null : Number(audioSeconds.toFixed(3))
    },
    failureDetail: ({ actual, expected }) =>
      `音轨 ${actual}s，画面 ${expected.target}s：短了 ${Math.abs(expected.target - actual).toFixed(3)}s，` +
      '这段时间里字幕会照常显示但没有声音（需要检查音轨装配而不是封装）。',
  },
  {
    id: 'loudness_target',
    category: 'audio',
    title: '整片响度落在计划目标上',
    severity: 'error',
    compares: 'within',
    needs: ['audio', 'plan'],
    expectation: (context) =>
      context.plan === null
        ? null
        : { target: context.plan.audio.loudnessTarget, tolerance: context.options.loudnessToleranceLu ?? QC_DEFAULTS.loudnessToleranceLu },
    measure: (context) => context.audio?.loudness?.loudness?.integratedLufs ?? null,
    evidence: (context) => ({ loudnessRangeLu: context.audio?.loudness?.loudness?.loudnessRangeLu ?? null }),
  },
  {
    id: 'true_peak',
    category: 'audio',
    title: '真峰值不超过上限',
    severity: 'error',
    compares: 'atMost',
    needs: ['audio'],
    expectation: (context) => ({ limit: context.options.truePeakCeilingDbtp ?? QC_DEFAULTS.truePeakCeilingDbtp }),
    measure: (context) => context.audio?.loudness?.loudness?.truePeakDbfs ?? null,
    failureDetail: ({ actual, expected }) => `真峰值 ${actual} dBTP 超过 ${expected.limit} dBTP：转码成有损格式时会有削波风险。`,
  },
  {
    id: 'clipping',
    category: 'audio',
    title: '没有采样级削波',
    severity: 'warn',
    compares: 'atMost',
    needs: ['audio'],
    expectation: () => ({ limit: 0 }),
    measure: (context) => context.audio?.levels?.clipping?.totalHighSamples ?? null,
    evidence: (context) => ({ runs: context.audio?.levels?.clipping?.runs?.slice(0, 5) ?? [] }),
    failureDetail: ({ actual }) => `有 ${actual} 个满刻度采样点：先看 evidence.runs 的位置，再决定是重混还是接受。`,
  },
  {
    id: 'dc_offset',
    category: 'audio',
    title: '没有明显直流偏置',
    severity: 'warn',
    compares: 'atMost',
    needs: ['audio'],
    expectation: (context) => ({ limit: context.options.dcOffsetLimit ?? QC_DEFAULTS.dcOffsetLimit }),
    measure: (context) => (context.audio === null ? null : Math.abs(context.audio.levels.dcOffset)),
  },
  {
    id: 'head_silence',
    category: 'audio',
    title: '开头没有过长静音',
    severity: 'warn',
    compares: 'atMost',
    needs: ['audio'],
    expectation: (context) => ({ limit: context.options.headSilenceLimitSeconds ?? QC_DEFAULTS.headSilenceLimitSeconds }),
    measure: (context) => context.audio?.headSilenceSeconds ?? null,
  },
  {
    id: 'tail_silence',
    category: 'audio',
    title: '结尾没有过长静音',
    severity: 'warn',
    compares: 'atMost',
    needs: ['audio'],
    expectation: (context) => ({ limit: context.options.tailSilenceLimitSeconds ?? QC_DEFAULTS.tailSilenceLimitSeconds }),
    measure: (context) => context.audio?.tailSilenceSeconds ?? null,
  },
  {
    id: 'cues_within_picture',
    category: 'narration',
    title: '最后一条字幕在画面之内',
    severity: 'error',
    compares: 'atMost',
    needs: ['structure', 'plan'],
    expectation: (context) => (context.narration.lastEndSeconds === null ? null : { limit: Number(context.structure.info.duration.toFixed(3)) }),
    measure: (context) => context.narration.lastEndSeconds,
    evidence: (context) => ({ source: context.narration.source, count: context.narration.count }),
    failureDetail: ({ actual, expected }) => `最后一条旁白结束于 ${actual}s，画面只有 ${expected.limit}s：结尾被切掉了。`,
  },
  {
    id: 'cues_within_audio',
    category: 'narration',
    title: '最后一条字幕有声音托着',
    severity: 'error',
    compares: 'atMost',
    needs: ['structure', 'plan'],
    expectation: (context) => {
      const audioSeconds = context.structure.streams.audioSeconds
      return context.narration.lastEndSeconds === null || audioSeconds === null ? null : { limit: Number(audioSeconds.toFixed(3)) }
    },
    measure: (context) => context.narration.lastEndSeconds,
    failureDetail: ({ actual, expected }) =>
      `最后一条旁白结束于 ${actual}s，音轨只到 ${expected.limit}s：最后一句话只有字幕没有声音。`,
  },
  {
    id: 'no_placeholder_text',
    category: 'subtitles',
    title: '字幕里没有占位符',
    severity: 'error',
    compares: 'clean',
    needs: ['plan'],
    expectation: (context) => (context.subtitleSourceText === null ? null : { target: [] }),
    measure: (context) => (context.subtitleSourceText === null ? null : findPlaceholders(context.subtitleSourceText)),
    failureDetail: ({ actual }) => `字幕里出现了 ${actual.join(', ')}：这是没写完就被交付的信号。`,
  },
  {
    id: 'black_frames',
    category: 'picture',
    title: '没有长时间黑帧',
    severity: 'warn',
    compares: 'runsAtMost',
    needs: ['picture'],
    expectation: (context) => ({ limitSeconds: context.options.maxBlackRunSeconds ?? QC_DEFAULTS.maxBlackRunSeconds }),
    measure: (context) => context.picture?.blackRuns ?? null,
    evidence: (context) => ({
      blackLumaThreshold: context.picture?.blackLumaThreshold ?? null,
      probeFps: context.picture?.probeFps ?? null,
      worst: (context.picture?.blackRuns ?? []).slice(0, 3),
    }),
    failureDetail: ({ actual, expected }) => {
      const worst = (actual ?? []).reduce((best, run) => (best === null || run.seconds > best.seconds ? run : best), null)
      return worst === null
        ? '黑帧超长。'
        : `最长黑帧 ${worst.seconds}s（${worst.fromSeconds}s 起），上限 ${expected.limitSeconds}s：可能是渲染失败、转场吃掉了镜头，或片尾多留了黑场。`;
    },
  },
  {
    id: 'frozen_frames',
    category: 'picture',
    title: '没有长时间冻帧',
    severity: 'warn',
    compares: 'runsAtMost',
    needs: ['picture'],
    expectation: (context) => ({ limitSeconds: context.options.maxFrozenRunSeconds ?? QC_DEFAULTS.maxFrozenRunSeconds }),
    measure: (context) => context.picture?.frozenRuns ?? null,
    evidence: (context) => ({ probeFps: context.picture?.probeFps ?? null, worst: (context.picture?.frozenRuns ?? []).slice(0, 3) }),
    failureDetail: ({ actual, expected }) => {
      const worst = (actual ?? []).reduce((best, run) => (best === null || run.seconds > best.seconds ? run : best), null)
      return worst === null
        ? '冻帧超长。'
        : `最长冻帧 ${worst.seconds}s（${worst.fromSeconds}s 起），上限 ${expected.limitSeconds}s。` +
          '注意：故意做的静止画面也会触发这一条，它报的是"这里连续多帧完全一样"，不是"这里不好看"。';
    },
  },
  {
    id: 'letterbox',
    category: 'picture',
    title: '画面边缘没有黑边',
    severity: 'warn',
    compares: 'atMost',
    needs: ['picture'],
    expectation: (context) => ({ limit: context.options.barLimitFraction ?? QC_DEFAULTS.barLimitFraction }),
    measure: (context) => {
      const bars = context.picture?.bars
      if (bars === undefined || bars === null) return null
      return Math.max(bars.top, bars.bottom, bars.left, bars.right)
    },
    evidence: (context) => context.picture?.bars ?? null,
    failureDetail: ({ actual, expected }) => `最宽黑边占画面 ${(actual * 100).toFixed(1)}%，上限 ${(expected.limit * 100).toFixed(0)}%。`,
  },
  {
    id: 'cover_frame',
    category: 'deliverable',
    title: '封面帧已生成且不是空文件',
    severity: 'warn',
    compares: 'atLeast',
    needs: ['files'],
    expectation: () => ({ limit: 1024 }),
    measure: (context) => context.files?.cover?.sizeBytes ?? null,
  },
  {
    id: 'build_report_clean',
    category: 'deliverable',
    title: '交付报告里没有问题',
    severity: 'warn',
    compares: 'atMost',
    needs: ['files'],
    expectation: () => ({ limit: 0 }),
    measure: (context) => context.files?.problemsTotal ?? null,
    evidence: (context) => ({ problems: context.files?.problems ?? null, report: context.files?.buildReport ?? null }),
    failureDetail: ({ actual }) => `build-report.json 里有 ${actual} 条 problem：那是渲染端自己报的，先看它。`,
  },
]

/** Every case id, in catalogue order. */
export function caseIds() {
  return CASE_CATALOGUE.map((definition) => definition.id)
}

/**
 * Merge a case file's overrides into the catalogue.
 *
 * The file is the "test case" half of this feature: it may retune a threshold, change a
 * severity, or disable a case, but it can never add a judgement this module does not have.
 *
 * @param {object|null} document - the parsed case file, `{ cases: { id: overrides } }`.
 * @returns {Map<string, object>} overrides by case id.
 */
export function readCaseOverrides(document) {
  const overrides = new Map()
  const entries = document?.cases ?? document ?? {}
  if (entries === null || typeof entries !== 'object') return overrides
  for (const [id, value] of Object.entries(entries)) {
    if (value !== null && typeof value === 'object') overrides.set(id, value)
  }
  return overrides
}

/**
 * Choose which cases to run.
 * @param {object} [options] - the selection.
 * @param {string[]} [options.only] - run only these ids.
 * @param {string[]} [options.skip] - drop these ids.
 * @param {Map<string, object>} [options.overrides] - case-file entries, consulted for `enabled`.
 * @returns {{selected: object[], unknown: string[]}} the definitions to run, and unknown ids.
 */
export function selectCases(options = {}) {
  const overrides = options.overrides ?? new Map()
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : null
  const skip = new Set(Array.isArray(options.skip) ? options.skip : [])
  const unknown = []
  if (only !== null) {
    for (const id of only) {
      if (!CASE_CATALOGUE.some((definition) => definition.id === id)) unknown.push(id)
    }
  }
  const selected = CASE_CATALOGUE.filter((definition) => {
    if (only !== null && !only.has(definition.id)) return false
    if (skip.has(definition.id)) return false
    if (overrides.get(definition.id)?.enabled === false) return false
    return true
  })
  return { selected, unknown }
}

/**
 * Run the quality-control cases against one delivered file.
 *
 * Measurements are taken only for the cases that were selected, so `only: ["faststart"]` costs
 * one probe rather than a full decode.
 *
 * @param {object} options - the run.
 * @param {string} options.target - the delivered file.
 * @param {object|null} [options.plan] - the resolved plan, when there is one.
 * @param {object} [options.config] - normalized plugin config.
 * @param {string[]} [options.only] - run only these case ids.
 * @param {string[]} [options.skip] - drop these case ids.
 * @param {Map<string, object>} [options.overrides] - case-file entries.
 * @param {boolean} [options.strict] - treat a failed warning as a failure.
 * @param {object} [options.thresholds] - overrides for {@link QC_DEFAULTS}.
 * @param {boolean} [options.picture] - take the picture measurements; default true.
 * @returns {Promise<object>} the verdicts, the summary counts and the raw measurements.
 */
export async function runQc(options) {
  const target = options.target
  if (typeof target !== 'string' || target === '') throw new QcError('video_qc 需要 target。')
  if (!existsSync(target)) throw new QcError(`找不到要检查的文件：${target}`)

  const thresholds = { ...QC_DEFAULTS, ...(options.thresholds ?? {}) }
  const overrides = options.overrides ?? new Map()
  // A case file that names a case which does not exist is a typo, and a typo here would silently
  // disable the very check it meant to retune. Refuse it the same way an unknown `only` id is.
  const unknownCases = [...overrides.keys()].filter((id) => !CASE_CATALOGUE.some((definition) => definition.id === id))
  if (unknownCases.length > 0) {
    throw new QcError(`用例文件里有未知的用例 id：${unknownCases.join(', ')}；可用：${caseIds().join(', ')}`)
  }
  const { selected, unknown } = selectCases({ only: options.only, skip: options.skip, overrides })
  if (unknown.length > 0) {
    throw new QcError(`未知的用例 id：${unknown.join(', ')}；可用：${caseIds().join(', ')}`)
  }

  const plan = options.plan ?? null
  const context = {
    target,
    plan,
    planHasAudio: plan === null ? true : plan.audio.voiceover !== null || plan.audio.music !== null,
    options: thresholds,
    structure: null,
    picture: null,
    audio: null,
    files: null,
    narration: { source: null, lastEndSeconds: null, firstStartSeconds: null, count: 0 },
    subtitleSourceText: null,
    notes: [],
  }

  const needs = new Set(selected.flatMap((definition) => definition.needs))
  if (plan !== null) {
    context.narration = readNarrationTimings(plan)
    context.subtitleSourceText = plan.subtitles?.enabled === true ? subtitleText(plan) : null
  }
  if (needs.has('structure')) context.structure = await collectStructure(target, options.config ?? {})
  if (needs.has('files') || needs.has('plan')) context.files = collectFiles(target, plan)
  if (needs.has('audio')) {
    context.audio = await collectAudio(target, options.config ?? {}, thresholds)
    if (context.audio === null) context.notes.push('这个文件没有音轨，音频类用例会跳过。')
  }
  if (needs.has('picture')) {
    if (options.picture === false) context.notes.push('调用方要求跳过画面测量，画面类用例会跳过。')
    else context.picture = await collectPicture(target, options.config ?? {}, thresholds)
  }

  const results = selected.map((definition) => judgeCase(definition, context, overrides.get(definition.id) ?? {}))
  const failures = results.filter((result) => result.status === 'fail' && result.severity === 'error')
  const warnings = results.filter((result) => result.status === 'fail' && result.severity === 'warn')
  const skipped = results.filter((result) => result.status === 'skip')
  const passed = results.filter((result) => result.status === 'pass')

  return {
    target,
    planPath: options.planPath ?? null,
    strict: options.strict === true,
    ok: failures.length === 0 && (options.strict !== true || warnings.length === 0),
    counts: { total: results.length, passed: passed.length, failed: failures.length, warned: warnings.length, skipped: skipped.length },
    results,
    skippedReasons: skipped.map((result) => ({ id: result.id, reason: result.detail })),
    thresholds,
    notes: context.notes,
    measurements: {
      structure: context.structure,
      audio: context.audio,
      picture: context.picture,
      files: context.files,
      narration: context.narration,
    },
  }
}

/**
 * Render a run as plain text, the way a test runner prints.
 * @param {object} result - from {@link runQc}.
 * @returns {string} the report.
 */
export function formatQcReport(result) {
  const lines = [
    `video_qc ${result.ok ? '通过' : '未通过'}：${result.counts.passed} 通过 / ${result.counts.failed} 失败 / ${result.counts.warned} 警告 / ${result.counts.skipped} 跳过`,
    `文件：${result.target}`,
  ]
  if (result.planPath !== null) lines.push(`计划：${result.planPath}`)
  lines.push('')
  for (const caseResult of result.results) lines.push(formatCaseLine(caseResult))
  if (result.counts.skipped > 0) {
    lines.push('')
    lines.push(`跳过 ${result.counts.skipped} 条：`)
    for (const entry of result.skippedReasons) lines.push(`  - ${entry.id}：${entry.reason}`)
  }
  if (result.notes.length > 0) {
    lines.push('')
    for (const note of result.notes) lines.push(`注：${note}`)
  }
  return lines.join('\n')
}
