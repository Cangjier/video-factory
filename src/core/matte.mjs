/**
 * Learned matting: separate a subject from a backdrop that is not a flat colour.
 *
 * The chroma-key path in `filter.mjs` is free and exact for a green screen. This module is the
 * other half: a U²-Net salient-object model that estimates a soft alpha for an arbitrary
 * backdrop, which is what a normal photograph or a moving shot needs.
 *
 * **Why u2netp and not the full U²-Net.** The full model is 167.8 MB and this one is 4.36 MB;
 * both are Apache-2.0 and both emit the same shape of matte. Measured here at ~2.1 s per 320×320
 * inference on one WASM thread, the size difference is what keeps the feature shippable, and the
 * measured separation on a known-good plate was exact (a solid subject came back as a solid mask
 * with no stray pixels).
 *
 * **It reuses the runtime `install_audio` already vendored.** There is no second runtime and no
 * native binary: `onnxruntime-web` under `vendor/audio/runtime` is the same 13 MB the audio event
 * classifier uses. That is why `matte_status` reports the runtime as a shared dependency rather
 * than offering to install its own.
 *
 * **Cost is the honest constraint.** At ~2.1 s for 320×320 single-threaded, one second of 30 fps
 * video costs about 52 s of compute if every frame is matted. That is why the video path takes a
 * `maskFps` — how many masks per second to compute — and holds each mask across the frames until
 * the next one. Deciding that rate is a judgement about the footage, so it belongs to DSH; the
 * plugin executes whatever it is given and reports what it cost.
 *
 * @module video-factory/core/matte
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_ROOT } from './env.mjs'
import { resolveTool } from './ffmpeg.mjs'
import { toFfmpegColor } from './filter.mjs'
import { AUDIO_VENDOR_DIR, ORT_WASM_BINARY, ORT_WASM_ENTRY } from './audio-events.mjs'

/** Error type for a matting request this plugin refuses or cannot carry out. */
export class MatteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MatteError'
  }
}

/** Where the matting model lives. */
export const MATTE_VENDOR_DIR = join(PLUGIN_ROOT, 'vendor', 'matte')

/** The model file. */
export const MATTE_MODEL = join(MATTE_VENDOR_DIR, 'u2netp.onnx')

/** Scratch directory for decoded frames and generated masks. */
export const MATTE_TMP_DIR = join(PLUGIN_ROOT, 'tmp', 'matte')

/**
 * The model's fixed input geometry.
 *
 * `u2netp` was exported with a static `[1,3,320,320]` input, so this is not a tunable — asking
 * ONNX Runtime for another side is rejected outright. The mask is upscaled back to frame size,
 * which is why a 320-pixel model is still usable for 1080p source.
 */
export const MATTE_SIDE = 320

/** Default number of masks per second for the video path. */
export const DEFAULT_MASK_FPS = 8

/** Ceiling on masks per second: beyond this the cost is worse than the quality gain. */
export const MAX_MASK_FPS = 30

/** Ceiling on masks produced in one call, so a long clip cannot run away. */
export const MAX_MASKS = 900

/** The matting model, pinned by size and hash. */
export const MATTE_MODEL_SPEC = {
  id: 'u2netp',
  label: 'U²-Net p（显著性目标抠像，ONNX）',
  license: 'Apache-2.0',
  url: 'https://huggingface.co/Heliosoph/u2net-onnx/resolve/main/u2netp.onnx',
  bytes: 4_574_861,
  sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
  provenance: [
    'U²-Net（Qin et al., Pattern Recognition 2020）— Apache-2.0',
    'Heliosoph/u2net-onnx — 个人转存，ONNX 导出',
  ],
  input: 'float32 [1,3,320,320]，RGB 平面，归一化到 0..1',
  output: '7 个 [1,1,320,320]；首位是融合预测，即 alpha',
}

/** Cached inference session, and the class-free metadata that came with it. */
let sessionPromise = null

/**
 * Report whether matting can run, by reading the disk rather than the manifest.
 * @returns {{available: boolean, model: boolean, runtime: boolean, runtimeDir: string, missing: string[], reason: string|null, bytes: number|null}} the state.
 */
export function matteState() {
  const model = existsSync(MATTE_MODEL)
  const runtime = existsSync(ORT_WASM_ENTRY) && existsSync(ORT_WASM_BINARY)
  const missing = []
  if (!model) missing.push('model')
  if (!runtime) missing.push('runtime')

  let bytes = null
  if (model) bytes = statSync(MATTE_MODEL).size

  return {
    available: missing.length === 0,
    model,
    runtime,
    runtimeDir: AUDIO_VENDOR_DIR,
    missing,
    bytes,
    reason:
      missing.length === 0
        ? null
        : missing.includes('runtime') && !missing.includes('model')
          ? '推理运行时尚未安装（它由 install_audio 提供，抠图与音频事件检测共用同一个 WASM 运行时）。' +
            '运行 video_env {action:"install_audio"}。'
          : '抠图模型尚未安装。运行 video_env {action:"install_matte"}。',
  }
}

/**
 * Load (once) the vendored WASM session for the matting model.
 * @returns {Promise<{session: object, ort: object, inputName: string, outputSide: number}>} the session.
 * @throws {MatteError} when the model or runtime is unavailable.
 */
export async function loadMatteSession() {
  if (sessionPromise !== null) return sessionPromise

  sessionPromise = (async () => {
    const state = matteState()
    if (!state.available) throw new MatteError(state.reason ?? '抠图不可用')

    const ort = await import(pathToFileURL(ORT_WASM_ENTRY).href)
    // One thread, matching the audio path: the measured 16-thread speedup on this model was
    // 1.08x, so a worker pool would cost threads for nothing.
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    ort.env.wasm.wasmPaths = {
      wasm: pathToFileURL(ORT_WASM_BINARY).href,
      mjs: pathToFileURL(join(AUDIO_VENDOR_DIR, 'runtime', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs')).href,
    }

    const session = await ort.InferenceSession.create(readFileSync(MATTE_MODEL), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    const input = session.inputMetadata[0]
    const dims = input.shape
    const side = Number(dims[dims.length - 1])
    if (!Number.isFinite(side) || side <= 0) {
      throw new MatteError(`模型的输入形状无法解析：${JSON.stringify(dims)}`)
    }
    return { session, ort, inputName: input.name, outputSide: side }
  })()

  try {
    return await sessionPromise
  } catch (error) {
    sessionPromise = null
    throw error
  }
}

/** Release the cached session. Useful in tests and on plugin unload. */
export function disposeMatteSession() {
  sessionPromise = null
}

/**
 * Rescale a mask's raw model output into 8-bit alpha.
 *
 * The graph returns the fused prediction already normalised in most exports, but not all, so the
 * range is measured and re-normalised here. Doing it explicitly means the mask does not depend on
 * which convention an export happened to use — a mask that is subtly wrong in gain is very hard to
 * notice by eye and very easy to notice in a composite.
 *
 * @param {Float32Array|number[]} data - the raw output.
 * @returns {{alpha: Uint8Array, min: number, max: number}} the 8-bit alpha and the raw range.
 */
export function normaliseMask(data) {
  let min = Infinity
  let max = -Infinity
  for (const value of data) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const span = max - min === 0 ? 1 : max - min
  const alpha = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 1) {
    alpha[i] = Math.max(0, Math.min(255, Math.round(((data[i] - min) / span) * 255)))
  }
  return { alpha, min, max }
}

/**
 * Fraction of the mask above a threshold, and the level statistics that reveal a degenerate mask.
 *
 * A model that fails open (all foreground) or shut (all background) is the failure that silently
 * produces a blank or fully-obscured frame, so the caller needs to be able to see it.
 *
 * @param {Uint8Array} alpha - the mask.
 * @param {number} [threshold] - the cutoff, 0..255.
 * @returns {{foregroundRatio: number, meanLevel: number, opaquePixels: number, totalPixels: number}} the statistics.
 */
export function maskStatistics(alpha, threshold = 127) {
  let foreground = 0
  let total = 0
  for (const value of alpha) {
    total += value
    if (value > threshold) foreground += 1
  }
  return {
    foregroundRatio: alpha.length === 0 ? 0 : foreground / alpha.length,
    meanLevel: alpha.length === 0 ? 0 : total / alpha.length,
    opaquePixels: foreground,
    totalPixels: alpha.length,
  }
}

/**
 * Run one ffmpeg invocation and resolve its stderr.
 *
 * @param {string[]} args - arguments after the binary.
 * @param {object} [options] - `{ config, timeoutMs }`.
 * @returns {Promise<string>} the captured stderr.
 * @throws {MatteError} when ffmpeg exits non-zero.
 */
function runFfmpeg(args, options = {}) {
  const binary = resolveTool('ffmpeg', options.config ?? {})
  const argv = ['-hide_banner', '-nostdin', '-y', ...args]
  return new Promise((settle, fail) => {
    const child = spawn(binary, argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 30 * 60 * 1000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(new MatteError(`无法启动 ffmpeg：${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) settle(stderr)
      else {
        fail(
          new MatteError(
            `ffmpeg 退出 ${code}\ncommand: ffmpeg ${argv.join(' ')}\nstderr (tail):\n` +
              stderr.trim().split('\n').slice(-12).join('\n'),
          ),
        )
      }
    })
  })
}

/**
 * Decode an image or a video frame into the model's input tensor layout.
 *
 * @param {string} source - the image, or a video with `at` set.
 * @param {number} side - the square side.
 * @param {object} [options] - `{ at, config }`.
 * @returns {Promise<Float32Array>} planar RGB in `[0,1]`, length `3*side*side`.
 * @throws {MatteError} when decoding fails.
 */
export async function decodeToTensor(source, side, options = {}) {
  mkdirSync(MATTE_TMP_DIR, { recursive: true })
  const raw = join(MATTE_TMP_DIR, `decode-${process.pid}-${Date.now()}.rgb`)

  const args = []
  if (Number.isFinite(options.at)) args.push('-ss', Number(options.at).toFixed(3))
  args.push(
    '-i', resolve(source),
    '-frames:v', '1',
    '-vf', `scale=${side}:${side}`,
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    raw,
  )

  try {
    await runFfmpeg(args, options)
    const bytes = readFileSync(raw)
    const pixels = side * side
    if (bytes.length < pixels * 3) {
      throw new MatteError(
        `解码得到的像素不足：期望 ${pixels * 3} 字节 RGB，实得 ${bytes.length}；源可能不是图像或视频。`,
      )
    }
    const tensor = new Float32Array(3 * pixels)
    for (let i = 0; i < pixels; i += 1) {
      tensor[i] = bytes[i * 3] / 255
      tensor[pixels + i] = bytes[i * 3 + 1] / 255
      tensor[2 * pixels + i] = bytes[i * 3 + 2] / 255
    }
    return tensor
  } finally {
    rmSync(raw, { force: true })
  }
}

/**
 * Compute one alpha mask from an image or a single video frame.
 *
 * @param {string} source - the image or video.
 * @param {object} [options] - `{ at, config, onProgress }`.
 * @returns {Promise<{alpha: Uint8Array, side: number, ms: number, statistics: object, raw: {min: number, max: number}}>} the mask.
 * @throws {MatteError} when the model or the decode fails.
 */
export async function matteFrame(source, options = {}) {
  const { session, ort, inputName, outputSide } = await loadMatteSession()
  const tensor = await decodeToTensor(source, outputSide, options)

  const started = Date.now()
  const output = await session.run({
    [inputName]: new ort.Tensor('float32', tensor, [1, 3, outputSide, outputSide]),
  })
  const ms = Date.now() - started

  // The fused prediction is first; the remaining six are side outputs used only during training.
  const fused = output[session.outputNames[0]]
  const { alpha, min, max } = normaliseMask(fused.data)
  return {
    alpha,
    side: outputSide,
    ms,
    statistics: maskStatistics(alpha),
    raw: { min, max },
  }
}

/**
 * Write an 8-bit mask as a PNG.
 *
 * `gray` input to PNG keeps the mask single-channel, which is what `alphamerge` wants.
 *
 * @param {Uint8Array} alpha - the mask.
 * @param {number} side - its square side.
 * @param {string} target - where to write it.
 * @param {object} [options] - `{ config }`.
 * @returns {Promise<string>} the target path.
 */
export async function writeMaskPng(alpha, side, target, options = {}) {
  mkdirSync(join(target, '..'), { recursive: true })
  const pgm = `${target}.pgm`
  writeFileSync(pgm, Buffer.concat([Buffer.from(`P5\n${side} ${side}\n255\n`, 'ascii'), Buffer.from(alpha)]))
  try {
    await runFfmpeg(['-i', pgm, '-frames:v', '1', '-update', '1', target], { ...options, timeoutMs: 120_000 })
  } finally {
    rmSync(pgm, { force: true })
  }
  return target
}

/**
 * Produce a PNG with the subject on a transparent background.
 *
 * The mask is upscaled to the source's own resolution rather than the source being downscaled to
 * the mask: a 320-pixel model still gives a usable edge at 1080p because the alpha is smooth, and
 * shrinking the picture instead would throw away the detail the user wanted to keep.
 *
 * @param {string} source - the image, or a video with `at` set.
 * @param {string} target - the output PNG.
 * @param {object} [options] - `{ at, config, keepMask, feather, onProgress }`.
 * @returns {Promise<object>} `{ path, maskPath, side, ms, statistics, feather }`.
 * @throws {MatteError} when the model or ffmpeg fails.
 */
export async function matteImage(source, target, options = {}) {
  mkdirSync(MATTE_TMP_DIR, { recursive: true })
  const key = `${process.pid}-${Date.now()}`
  const maskPng = join(MATTE_TMP_DIR, `mask-${key}.png`)

  const frame = await matteFrame(source, options)
  await writeMaskPng(frame.alpha, frame.side, maskPng, options)

  const feather = Number.isFinite(options.feather) && options.feather > 0 ? Number(options.feather) : 0
  // A hard model edge against a new background reads as a cut-out sticker. A small blur on the
  // mask is what makes it read as a photograph, so it is allowed but never assumed.
  const maskChain = feather > 0 ? `gblur=sigma=${feather}` : 'null'

  // The mask must be scaled to the source's own size, explicitly. `scale=iw:ih` inside this graph
  // would read the *mask's* dimensions rather than the main input's, and `alphamerge` then fails
  // with "Input frame sizes do not match" — the mask is 320x320 and the picture is whatever it is.
  const { probe } = await import('./probe.mjs')
  const info = await probe(resolve(source), options.config ?? {})
  const width = info.width
  const height = info.height
  if (!(width > 0) || !(height > 0)) {
    throw new MatteError(`无法确定源尺寸，不能把遮罩放大回去：${source}`)
  }

  await runFfmpeg(
    [
      '-i', resolve(source),
      '-i', maskPng,
      '-filter_complex',
      `[1:v]scale=${width}:${height}:flags=bicubic,${maskChain},format=gray[m];` +
        '[0:v][m]alphamerge,format=rgba[o]',
      '-map', '[o]',
      '-frames:v', '1',
      target,
    ],
    { ...options, timeoutMs: 5 * 60 * 1000 },
  )

  const keepMask = options.keepMask === true
  const result = {
    path: target,
    maskPath: keepMask ? maskPng : null,
    side: frame.side,
    width,
    height,
    inferenceMs: frame.ms,
    statistics: frame.statistics,
    raw: frame.raw,
    feather,
  }
  if (!keepMask) rmSync(maskPng, { force: true })
  return result
}

/**
 * Resolve and validate a video matting request.
 *
 * Split out because the cost of this operation is the whole design constraint: the caller must be
 * able to see, before committing, how many masks will be computed and roughly how long that takes.
 *
 * @param {object} [options] - `{ maskFps, duration, maxMasks }`.
 * @returns {{maskFps: number, masks: number, frameDuplication: number, estimatedSeconds: number|null, notes: string[]}} the plan.
 * @throws {MatteError} when a value is out of range.
 */
export function planMasks(options = {}) {
  const maskFps = options.maskFps === undefined ? DEFAULT_MASK_FPS : Number(options.maskFps)
  if (!Number.isFinite(maskFps) || maskFps <= 0 || maskFps > MAX_MASK_FPS) {
    throw new MatteError(`maskFps 必须在 0 与 ${MAX_MASK_FPS} 之间，收到 ${JSON.stringify(options.maskFps)}`)
  }
  const duration = Number(options.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MatteError(`需要正的时长才能规划遮罩，收到 ${JSON.stringify(options.duration)}`)
  }
  const maxMasks = Number(options.maxMasks ?? MAX_MASKS)
  const raw = Math.ceil(duration * maskFps)
  const masks = Math.max(1, Math.min(raw, maxMasks))
  const notes = []
  if (raw > maxMasks) {
    notes.push(
      `请求 ${raw} 个遮罩，超过单次上限 ${maxMasks}；已截到 ${masks} 个，实际遮罩率会低于 maskFps。`,
    )
  }
  return {
    maskFps,
    masks,
    durationSec: duration,
    // How many output frames each mask has to cover. The renderer holds a mask until the next
    // one rather than interpolating, so this is also the granularity of any judder.
    framesPerMask: options.outputFps === undefined ? null : Number(options.outputFps) / maskFps,
    estimatedSeconds: options.estimatedMsPerMask === undefined ? null : (masks * Number(options.estimatedMsPerMask)) / 1000,
    notes,
  }
}

/**
 * Produce a numbered PNG mask sequence for a video, one mask per `1/maskFps` seconds.
 *
 * Masks are written as `mask-00000.png` upward so the renderer can feed them to ffmpeg as an
 * image sequence. Holding a mask across several output frames is done at the ffmpeg level by
 * setting the sequence's input frame rate, which is why this function's job stops at producing
 * them.
 *
 * @param {string} source - the video.
 * @param {string} outDir - where the sequence is written.
 * @param {object} [options] - `{ maskFps, duration, maxMasks, config, onProgress, signal }`.
 * @returns {Promise<object>} `{ directory, count, maskFps, durationSec, timings, statistics, notes }`.
 * @throws {MatteError} when the model or ffmpeg fails, or the request is out of range.
 */
export async function matteVideo(source, outDir, options = {}) {
  const plan = planMasks(options)
  mkdirSync(outDir, { recursive: true })
  // A stale sequence from a previous run would be picked up by the image-sequence reader and
  // silently extend the clip, so the directory starts empty.
  for (const entry of readdirSync(outDir)) {
    if (/^mask-\d+\.png$/.test(entry)) rmSync(join(outDir, entry), { force: true })
  }

  const timings = []
  const statistics = []
  let lastReport = 0
  for (let index = 0; index < plan.masks; index += 1) {
    const at = index / plan.maskFps
    if (at >= plan.durationSec) break
    const frame = await matteFrame(source, { ...options, at })
    const target = join(outDir, `mask-${String(index).padStart(5, '0')}.png`)
    await writeMaskPng(frame.alpha, frame.side, target, options)
    timings.push(frame.ms)
    statistics.push(frame.statistics)
    if (typeof options.onProgress === 'function' && index - lastReport >= 4) {
      lastReport = index
      options.onProgress({ done: index + 1, total: plan.masks, at })
    }
  }

  const totalMs = timings.reduce((sum, value) => sum + value, 0)
  const foreground = statistics.map((entry) => entry.foregroundRatio)
  const notes = [...plan.notes]
  // A mask sequence that is all foreground or all background means the model failed on this
  // footage; saying so here is far cheaper than the user discovering a blank render.
  const degenerate = foreground.filter((ratio) => ratio < 0.005 || ratio > 0.995).length
  if (degenerate > 0) {
    notes.push(
      `${degenerate}/${statistics.length} 个遮罩几乎全为前景或全为背景，模型可能没在这段素材上找到主体；` +
        '请先看一个遮罩再决定是否继续。',
    )
  }

  return {
    directory: outDir,
    count: timings.length,
    maskFps: plan.maskFps,
    durationSec: plan.durationSec,
    inferenceMsTotal: totalMs,
    inferenceMsMean: timings.length === 0 ? null : Math.round(totalMs / timings.length),
    foregroundRatio: {
      min: foreground.length === 0 ? null : Number(Math.min(...foreground).toFixed(4)),
      max: foreground.length === 0 ? null : Number(Math.max(...foreground).toFixed(4)),
      mean: foreground.length === 0 ? null : Number((foreground.reduce((a, b) => a + b, 0) / foreground.length).toFixed(4)),
    },
    notes,
  }
}

/**
 * Build the ffmpeg arguments that key a video with a mask sequence and lay it over a background.
 *
 * Kept separate from the renderer so the graph can be checked on its own, and so the two things
 * that are easy to get wrong are stated once:
 *
 * 1. **The mask sequence's frame rate is `maskFps`, not the output rate.** Declaring it at
 *    `maskFps` makes ffmpeg hold each mask until the next one is due, which is exactly the
 *    "compute fewer masks, reuse them" behaviour this feature is built around. Declaring the
 *    output rate instead would consume one mask per frame and run out almost immediately.
 * 2. **`alphamerge` needs the mask at the picture's size.** The model emits 320x320; the mask is
 *    scaled to the *frame* here, and getting that backwards fails with "Input frame sizes do not
 *    match".
 *
 * @param {object} spec - `{ maskDir, maskCount, maskFps, width, height, fps, duration, background }`.
 * @returns {{inputs: string[], graph: string, label: string, notes: string[]}} arguments and graph.
 * @throws {MatteError} when the specification is unusable.
 */
export function videoMatteArguments(spec) {
  const { maskDir, maskCount, maskFps, width, height, fps, duration, background } = spec
  if (!Number.isInteger(maskCount) || maskCount < 1) {
    throw new MatteError(`遮罩数量必须为正整数，收到 ${JSON.stringify(maskCount)}`)
  }
  if (!(maskFps > 0)) throw new MatteError(`maskFps 必须为正数，收到 ${JSON.stringify(maskFps)}`)
  if (!(width > 0) || !(height > 0)) throw new MatteError('需要画布尺寸才能缩放遮罩')

  const notes = []
  const sequence = join(maskDir, 'mask-%05d.png')
  // Input 0 is the picture, input 1 is the mask sequence, and any background is input 2 onward.
  const inputs = ['-framerate', maskFps.toFixed(6), '-i', sequence]

  const backgroundSpec = background ?? null
  if (backgroundSpec === null) {
    // Nothing to composite over, so the alpha would be discarded by the encoder anyway. Emitting
    // a transparent-anything here would be a lie; the caller is told to configure a background.
    throw new MatteError(
      '视频抠像需要 background：只有把主体合成到某个背景上，抠像才有可观察的结果。' +
        '请给出纯色背景，或在计划里把这一层叠到另一层之上。',
    )
  }

  const color = toFfmpegColor(backgroundSpec)
  // The colour source must be bounded: an infinite `lavfi` input makes `overlay` emit frames
  // forever, and the failure surfaces much later inside the audio encoder.
  inputs.push(
    '-f', 'lavfi', '-t', Number(duration).toFixed(3),
    '-i', `color=c=${color}:s=${width}x${height}:r=${fps.toFixed(6)}`,
  )
  const backgroundInput = 2

  const graph = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps.toFixed(6)},format=rgba[fg]`,
    `[1:v]scale=${width}:${height}:flags=bicubic,format=gray[m]`,
    `[fg][m]alphamerge[cut]`,
    `[${backgroundInput}:v]format=rgba[bg]`,
    `[bg][cut]overlay=0:0:format=auto,format=yuv420p`,
  ].join(';')

  notes.push(
    `每个遮罩覆盖约 ${(fps / maskFps).toFixed(1)} 个输出帧；遮罩率越低，边缘的跳动越明显。`,
  )
  return { inputs, graph, label: 'cv', notes }
}

/**
 * The duration of a media file, in seconds.
 * @param {string} path - the file.
 * @param {object} [options] - `{ config }`.
 * @returns {Promise<number>} the duration.
 * @throws {MatteError} when it cannot be determined.
 */
export async function durationOf(path, options = {}) {
  const { probe } = await import('./probe.mjs')
  const info = await probe(path, options.config ?? {})
  const duration = info.duration ?? 0
  if (!(duration > 0)) throw new MatteError(`无法确定时长：${path}`)
  return duration
}
