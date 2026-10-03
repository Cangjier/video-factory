/**
 * Adaptive frame sampling: decide *which* moments of a video are worth looking at.
 *
 * A fixed-interval dump (one frame every N seconds) spends the whole frame budget on a
 * static talking head and misses the one cut that mattered. This module instead decodes a
 * cheap grayscale proxy of the whole video and scores every decoded frame against its
 * predecessor, so a scene cut or a burst of movement selects itself.
 *
 * Two halves, deliberately separated:
 *
 * 1. {@link decodeLuma} shells out to ffmpeg for a raw `gray` stream. That is I/O and the
 *    only non-deterministic-cost part.
 * 2. {@link selectFrames} is a pure function over scores. It is the part that encodes a
 *    policy, so it is the part that is unit-tested without touching a video.
 *
 * **The score is resolution- and rate-dependent.** `sceneThreshold` and `motionThreshold`
 * are mean absolute 8-bit luma differences, so they only mean the same thing at the same
 * probe geometry and probe rate. Both are pinned in {@link SAMPLING_DEFAULTS} and echoed in
 * every result rather than hidden.
 *
 * @module video-factory/core/sampling
 */
import { run } from './ffmpeg.mjs'
import { probe } from './probe.mjs'

/** Error type for a sampling request this plugin refuses or cannot carry out. */
export class SamplingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SamplingError'
  }
}

/**
 * Which frames to keep.
 *
 * `uniform` ignores the scores entirely; `scene_change` and `motion_aware` each use one
 * signal; `adaptive` (the default) combines them the way the reference implementation does.
 */
export const SAMPLE_STRATEGIES = ['adaptive', 'uniform', 'scene_change', 'motion_aware']

/**
 * Every reason a frame can be selected. Reported verbatim so a caller can see *why* the
 * frame budget went where it did.
 */
export const SELECTION_REASONS = [
  'first_frame',
  'scene_change',
  'motion',
  'periodic',
  'uniform',
  'max_interval_fallback',
  'probe_rate_fallback',
]

/**
 * Defaults, copied from the reference implementation's tuned values so the behaviour is
 * comparable to the project this was modelled on.
 *
 * `probeWidth`/`probeHeight` are small on purpose: luma differences that drive a decision
 * do not need detail, and 160x90 keeps a whole feature film's proxy stream in the low
 * hundreds of megabytes even before it is consumed frame by frame.
 */
export const SAMPLING_DEFAULTS = {
  strategy: 'adaptive',
  probeFps: 4,
  probeWidth: 160,
  probeHeight: 90,
  targetFps: 1,
  minFps: 0.25,
  maxFps: 4,
  sceneThreshold: 30,
  motionThreshold: 5,
  maxFrames: 2000,
}

/** Hard ceiling on the decoded proxy rate, so a request cannot ask for an unbounded stream. */
export const MAX_PROBE_FPS = 30

/** Hard ceiling on the decoded proxy area, in pixels. */
export const MAX_PROBE_PIXELS = 640 * 360

/**
 * Validate and normalise sampling options.
 *
 * Everything is range-checked here rather than deep inside the decoder, so a bad request
 * fails before a single frame is decoded.
 *
 * @param {object} [options] - raw options.
 * @returns {object} the normalised options, with defaults filled in.
 * @throws {SamplingError} when a value is out of range.
 */
export function normaliseSamplingOptions(options = {}) {
  const merged = { ...SAMPLING_DEFAULTS, ...options }
  const strategy = String(merged.strategy ?? 'adaptive')
  if (!SAMPLE_STRATEGIES.includes(strategy)) {
    throw new SamplingError(`未知采样策略 ${JSON.stringify(strategy)}；可用：${SAMPLE_STRATEGIES.join(', ')}`)
  }

  const numbers = {}
  for (const key of [
    'probeFps',
    'probeWidth',
    'probeHeight',
    'targetFps',
    'minFps',
    'maxFps',
    'sceneThreshold',
    'motionThreshold',
    'maxFrames',
  ]) {
    const value = Number(merged[key])
    if (!Number.isFinite(value) || value <= 0) {
      throw new SamplingError(`${key} 必须是正数，收到 ${JSON.stringify(merged[key])}`)
    }
    numbers[key] = value
  }

  if (numbers.probeFps > MAX_PROBE_FPS) {
    throw new SamplingError(`probeFps 上限为 ${MAX_PROBE_FPS}，收到 ${numbers.probeFps}`)
  }
  if (numbers.probeWidth * numbers.probeHeight > MAX_PROBE_PIXELS) {
    throw new SamplingError(
      `probe 面积上限为 ${MAX_PROBE_PIXELS} 像素，收到 ${numbers.probeWidth * numbers.probeHeight}`,
    )
  }
  // 16 is the smallest width a yuv/gray scaler will not complain about in practice.
  if (numbers.probeWidth < 16 || numbers.probeHeight < 16) {
    throw new SamplingError('probeWidth / probeHeight 不得小于 16')
  }
  if (numbers.maxFps < numbers.minFps) {
    throw new SamplingError(`maxFps (${numbers.maxFps}) 不得小于 minFps (${numbers.minFps})`)
  }
  if (numbers.maxFrames < 1) {
    throw new SamplingError('maxFrames 至少为 1')
  }

  return { strategy, ...numbers }
}

/**
 * Mean absolute difference between two luma frames, in 8-bit levels.
 *
 * This is the whole signal the sampler runs on: a cut scores high, a slow pan scores low
 * but non-zero, a still frame scores zero.
 *
 * @param {Uint8Array} previous - the earlier frame.
 * @param {Uint8Array} current - the later frame.
 * @returns {number} the mean absolute difference, 0 when the frames are identical.
 * @throws {SamplingError} when the frames differ in length.
 */
export function meanAbsoluteDifference(previous, current) {
  if (previous.length !== current.length) {
    throw new SamplingError(`帧长度不一致：${previous.length} vs ${current.length}`)
  }
  let total = 0
  for (let i = 0; i < current.length; i += 1) total += Math.abs(current[i] - previous[i])
  return total / current.length
}

/**
 * Turn decoded frames into scored candidates.
 *
 * The first frame has no predecessor and therefore no score; it is reported as `first_frame`
 * by {@link selectFrames} rather than being given a fabricated score of zero.
 *
 * @param {Array<{index: number, at: number, luma: Uint8Array}>} frames - decoded frames in order.
 * @returns {Array<{index: number, at: number, sceneScore: number|null}>} scored candidates.
 */
export function scoreFrames(frames) {
  return frames.map((frame, position) => {
    if (position === 0) return { index: frame.index, at: frame.at, sceneScore: null }
    const sceneScore = meanAbsoluteDifference(frames[position - 1].luma, frame.luma)
    return { index: frame.index, at: frame.at, sceneScore }
  })
}

/**
 * Choose which scored frames to keep.
 *
 * Pure: same input, same output, no clock and no I/O. The decision order at each candidate
 * is the reference implementation's, and so is the reason it reports:
 *
 * - the first frame is always kept, so a video can never sample to nothing;
 * - a gap at or beyond `maxInterval` is a fallback, so a long static stretch still gets read;
 * - otherwise the strategy decides, and a gap at or beyond `targetInterval` is `periodic`.
 *
 * `motionScore` is carried through as an alias of `sceneScore`: with a fixed probe rate the
 * two signals are the same measurement, and reporting both names would imply a distinction
 * this decoder does not make.
 *
 * @param {Array<{index: number, at: number, sceneScore: number|null}>} candidates - from {@link scoreFrames}.
 * @param {object} [options] - normalised options.
 * @returns {{selected: object[], skipped: number, strategy: string}} the chosen frames.
 */
export function selectFrames(candidates, options = {}) {
  const config = normaliseSamplingOptions(options)
  const probeFps = config.probeFps
  const targetInterval = Math.max(1, Math.round(probeFps / config.targetFps))
  const minInterval = Math.max(1, Math.round(probeFps / config.maxFps))
  const maxInterval = Math.max(1, Math.round(probeFps / config.minFps))

  const selected = []
  let lastSelectedIndex = -Infinity

  for (const candidate of candidates) {
    if (selected.length >= config.maxFrames) break

    const gap = candidate.index - lastSelectedIndex
    const isFirst = selected.length === 0
    const score = candidate.sceneScore

    let reason = null
    if (isFirst) {
      reason = 'first_frame'
    } else if (gap < minInterval) {
      reason = null
    } else if (gap >= maxInterval) {
      reason = 'max_interval_fallback'
    } else if (config.strategy === 'uniform') {
      if (gap >= targetInterval) reason = 'uniform'
    } else if (config.strategy === 'scene_change') {
      if (score !== null && score >= config.sceneThreshold) reason = 'scene_change'
      else if (gap >= targetInterval) reason = 'periodic'
    } else if (config.strategy === 'motion_aware') {
      if (score !== null && score >= config.motionThreshold) reason = 'motion'
      else if (gap >= targetInterval) reason = 'periodic'
    } else {
      // adaptive: either signal may select a frame.
      if (score !== null && score >= config.sceneThreshold) reason = 'scene_change'
      else if (score !== null && score >= config.motionThreshold) reason = 'motion'
      else if (gap >= targetInterval) reason = 'periodic'
    }

    if (reason === null) continue

    selected.push({
      index: candidate.index,
      at: Number(candidate.at.toFixed(3)),
      reason,
      sceneScore: score === null ? null : Number(score.toFixed(3)),
      motionScore: score === null ? null : Number(score.toFixed(3)),
      gapFromPrevious: isFirst ? null : gap,
    })
    lastSelectedIndex = candidate.index
  }

  return { selected, skipped: candidates.length - selected.length, strategy: config.strategy }
}

/**
 * Decode a whole video to a grayscale proxy stream.
 *
 * ffmpeg writes raw `gray` to stdout and it is consumed here in frame-sized chunks, so peak
 * memory is one frame plus the frames kept for scoring, not the decoded video.
 *
 * @param {string} path - the video to decode.
 * @param {object} options - normalised options, plus `config`.
 * @param {(progress: object) => void} [onFrame] - called as frames arrive, for progress logs.
 * @returns {Promise<{frames: Array<{index: number, at: number, luma: Uint8Array}>, width: number, height: number, fps: number}>} decoded frames.
 * @throws {SamplingError} when the video cannot be decoded.
 */
export async function decodeLuma(path, options, onFrame) {
  const config = normaliseSamplingOptions(options)
  const frameBytes = config.probeWidth * config.probeHeight

  const result = await run({
    tool: 'ffmpeg',
    args: [
      '-v', 'error',
      '-i', path,
      '-an', '-sn',
      '-vf', `fps=${config.probeFps},scale=${config.probeWidth}:${config.probeHeight}`,
      '-pix_fmt', 'gray',
      '-f', 'rawvideo',
      '-',
    ],
    config: options.config ?? {},
    timeoutMs: options.timeoutMs ?? 900_000,
    stdoutEncoding: 'buffer',
    maxStdoutBytes: frameBytes * (config.maxFrames + 1),
  })

  const buffer = result.stdout ?? Buffer.alloc(0)
  const frameCount = Math.floor(buffer.length / frameBytes)
  if (frameCount === 0) {
    throw new SamplingError(
      `未能从 ${path} 解出任何帧（期望每帧 ${frameBytes} 字节，实得 ${buffer.length} 字节）`,
    )
  }

  const frames = []
  for (let index = 0; index < frameCount; index += 1) {
    const start = index * frameBytes
    const luma = new Uint8Array(frameBytes)
    // Buffer#copy into a Uint8Array view of the same length; subarray would alias the
    // whole decode buffer and pin it in memory for the life of the result.
    buffer.copy(luma, 0, start, start + frameBytes)
    frames.push({ index, at: index / config.probeFps, luma })
    if (typeof onFrame === 'function') onFrame({ index, total: frameCount })
  }

  return { frames, width: config.probeWidth, height: config.probeHeight, fps: config.probeFps }
}

/**
 * Sample a video end to end: decode, score, select.
 *
 * @param {string} path - the video to sample.
 * @param {object} [options] - normalised options, plus `config` and `onProgress`.
 * @returns {Promise<object>} `{ path, duration, probe, strategy, thresholds, frames, decoded, skipped }`.
 * @throws {SamplingError} when the video cannot be probed or decoded.
 */
export async function sampleFrames(path, options = {}) {
  const config = normaliseSamplingOptions(options)
  const info = await probe(path, options.config ?? {})
  const duration = info.duration ?? 0
  if (!(duration > 0)) {
    throw new SamplingError(`无法确定视频时长，不能采样：${path}`)
  }

  const decoded = await decodeLuma(path, options)
  const scored = scoreFrames(decoded.frames)
  const { selected, skipped, strategy } = selectFrames(scored, { ...config, probeFps: decoded.fps })

  return {
    path,
    duration: Number(duration.toFixed(3)),
    probe: {
      fps: decoded.fps,
      width: decoded.width,
      height: decoded.height,
      decodedFrames: decoded.frames.length,
    },
    strategy,
    thresholds: {
      sceneThreshold: config.sceneThreshold,
      motionThreshold: config.motionThreshold,
      targetFps: config.targetFps,
      minFps: config.minFps,
      maxFps: config.maxFps,
      maxFrames: config.maxFrames,
    },
    frames: selected,
    skipped,
    notes: [
      'sceneScore / motionScore 是相邻探测帧的平均绝对亮度差（0–255），只在同一 probe 分辨率与帧率下可比。',
      'motionScore 与 sceneScore 同源：固定探测帧率下二者是同一个测量值，不构成两个独立信号。',
    ],
  }
}
