/**
 * 字节跳动火山方舟（Volcengine Ark）视频生成适配器。
 *
 * 这里**刻意不做多厂商抽象**：没有 Provider 协议、没有 provider 注册表、没有能力协商。
 * 方舟的端点、字段名、错误码、分页方式都直接写在本文件里。
 *
 * 三条硬约束：
 * 1. 结果是 TOS 预签名链接（`X-Tos-Expires=86400`，**24 小时过期**），
 *    所以 {@link generate} 在轮询成功后**立刻下载落盘**，绝不把裸 URL 当交付物。
 * 2. `baseUrl` 是配置项而不是常量（区域/工作区不同）；`apiKey` 一律由调用方通过
 *    options 显式传入——**本模块从不读环境变量**，从哪里取 Key 是上层的决定。
 * 3. 参数支持按「模型 + 模式」分别限定（例如 `service_tier` 对 2.0 全系报
 *    "must be empty"），所以**只把调用方显式给出的字段放进请求体**，绝不补默认值。
 *
 * API 契约全部来自真实 Key 实测，见 `docs/插件设计规格.md` §7。
 *
 * @module video-factory/core/ark
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

/** 方舟默认接入点（北京区域，api v3）。 */
export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** 默认的 API Key 环境变量名。本模块只把它写进报错提示，自己并不读取它。 */
export const DEFAULT_KEY_ENV = 'ARK_API_KEY'

/** `listModels` 最多翻多少页，防止服务端忽略分页参数时无限循环。 */
const MAX_MODEL_PAGES = 50

/** `/models` 单页条数；实测该端点支持 `page_num` / `page_size`。 */
const MODEL_PAGE_SIZE = 100

/** `spec.mode` 的合法取值。 */
const MODES = ['text-to-video', 'image-to-video', 'first-last-frame']

/**
 * 已知的图像生成模型（实测账号可见且在售的那些）。
 *
 * 这里只是**给错误提示用的线索**，不是权威结论：`listModels({filter:'seedream'})` 才是。
 * 模型会下线（`doubao-seedream-3-0-t2i-250415` 与 `doubao-seededit-3-0-i2i-250628`
 * 实测都是 `Shutdown`），所以不要把它当白名单去拦调用。
 */
export const IMAGE_MODELS = [
  'doubao-seedream-5-0-flash-260915',
  'doubao-seedream-5-0-pro-260628',
  'doubao-seedream-4-0-20260415',
  'doubao-seedream-4-5-251128',
  'doubao-seedream-5-0-260128',
]

/** 缺省图像模型：在售且比 pro 便宜，适合先跑通。 */
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0]

/** 实测的图像面积下限：`512x512` 被拒，报 "image area must be at least 921600 pixels"。 */
export const IMAGE_MIN_PIXELS = 921_600

/** 实测的图像面积上限：`8192x8192` 被拒，报 "image area must be at most 4624220 pixels"。 */
export const IMAGE_MAX_PIXELS = 4_624_220

/** 本地图片扩展名 → MIME。方舟接受 base64 data URL 作为首/末帧。 */
const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
])

/**
 * `spec` 的 camelCase 字段 → 方舟请求体的 snake_case 字段。
 * 只有出现在这张表里的字段才可能进请求体，且**值为 undefined/null 时一律跳过**。
 */
const OPTIONAL_FIELDS = [
  ['duration', 'duration'],
  ['resolution', 'resolution'],
  ['ratio', 'ratio'],
  ['seed', 'seed'],
  ['watermark', 'watermark'],
  ['cameraFixed', 'camera_fixed'],
  ['generateAudio', 'generate_audio'],
  ['draft', 'draft'],
  ['returnLastFrame', 'return_last_frame'],
  ['serviceTier', 'service_tier'],
]

/** 服务端 status → 归一化 state。未列出的取值归 `unknown`。 */
const STATE_ALIASES = new Map([
  ['queued', 'pending'],
  ['pending', 'pending'],
  ['created', 'pending'],
  ['submitted', 'pending'],
  ['waiting', 'pending'],
  ['in_queue', 'pending'],
  ['running', 'running'],
  ['processing', 'running'],
  ['generating', 'running'],
  ['in_progress', 'running'],
  ['succeeded', 'succeeded'],
  ['success', 'succeeded'],
  ['completed', 'succeeded'],
  ['done', 'succeeded'],
  ['failed', 'failed'],
  ['failure', 'failed'],
  ['error', 'failed'],
  ['expired', 'expired'],
  ['timeout', 'expired'],
  ['timed_out', 'expired'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
  ['deleted', 'cancelled'],
])

/**
 * 适配器的统一错误类型：所有**可预期**的失败都抛它。
 *
 * 不抛裸的 HTTP 状态或网络异常，是为了让上层（`video_gen`）不必再解释一遍
 * `ModelNotOpen`、401、超时这些方舟特有的含义。
 */
export class ArkError extends Error {
  /**
   * @param {string} message - 面向用户的完整说明。
   * @param {object} [details] - 结构化上下文。
   * @param {string|null} [details.code] - 方舟错误码，如 `ModelNotOpen`。
   * @param {number|null} [details.status] - HTTP 状态码。
   * @param {string|null} [details.requestId] - 方舟请求 id，用于找客服对账。
   * @param {string|null} [details.jobId] - 相关任务 id。
   * @param {any} [details.raw] - 服务端原始响应体。
   * @param {any} [details.cause] - 底层异常。
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'ArkError'
    this.code = details.code ?? null
    this.status = details.status ?? null
    this.requestId = details.requestId ?? null
    this.jobId = details.jobId ?? null
    this.raw = details.raw ?? null
    if (details.cause !== undefined) this.cause = details.cause
  }
}

/**
 * 读取账号可见的 Seedance 模型。
 *
 * 分页拉全量后按 `id` 过滤（默认含 `seedance`），并按 `status` 分档：
 * `undefined/缺失 → live`、`Retiring → retiring`、`Shutdown → shutdown`，
 * **其他未预期取值也归 `shutdown` 并原样保留 `status`**。
 *
 * 这是判断「哪个模型可用」的唯一权威路径：不要硬编码任何模型 id 结论。
 *
 * @param {object} options - 调用参数。
 * @param {string} options.apiKey - 方舟 API Key，必填。
 * @param {string} [options.baseUrl] - 接入点，默认 {@link DEFAULT_BASE_URL}。
 * @param {string} [options.filter] - 模型 id 过滤子串，默认 `'seedance'`。
 * @returns {Promise<{models: {id: string, name: string|null, status: string|null, availability: 'live'|'retiring'|'shutdown'}[], total: number, scanned: number}>}
 *   `models` 为过滤后的模型，`total` 为 `models.length`，`scanned` 为账号可见模型总数（未过滤）。
 */
export async function listModels(options = {}) {
  const { apiKey } = options
  const baseUrl = options.baseUrl
  const filter = typeof options.filter === 'string' && options.filter !== '' ? options.filter : 'seedance'

  const catalogue = new Map()
  for (let page = 1; page <= MAX_MODEL_PAGES; page += 1) {
    const payload = await request(`/models?page_num=${page}&page_size=${MODEL_PAGE_SIZE}`, { apiKey, baseUrl })
    const rows = Array.isArray(payload?.data) ? payload.data : []
    if (rows.length === 0) break

    let added = 0
    for (const row of rows) {
      const id = row?.id
      if (typeof id !== 'string' || id === '' || catalogue.has(id)) continue
      catalogue.set(id, row)
      added += 1
    }
    if (rows.length < MODEL_PAGE_SIZE) break // 不满一页即最后一页
    if (added === 0) break // 服务端忽略了分页参数，再翻只会拿到同一页
  }

  const models = [...catalogue.values()]
    .filter((row) => row.id.includes(filter))
    .map((row) => ({
      id: row.id,
      name: row.name ?? null,
      status: row.status ?? null,
      availability: availabilityOf(row.status),
    }))

  return { models, total: models.length, scanned: catalogue.size }
}

/**
 * 提交一个生成任务。
 *
 * 请求体只包含调用方显式给出的字段；`serviceTier` 未给就绝不出现（2.0 系会因此报错）。
 * 本地图片路径会被读成 base64 data URL。
 *
 * @param {object} spec - 生成规格，见 {@link generate} 的 `spec` 说明。
 * @param {object} options - 调用参数。
 * @param {string} options.apiKey - 方舟 API Key，必填。
 * @param {string} [options.baseUrl] - 接入点。
 * @returns {Promise<{jobId: string, raw: object}>} 任务 id 与服务端原始响应。
 */
export async function submit(spec, options = {}) {
  const { body } = buildRequestBody(spec)
  const payload = await request('/contents/generations/tasks', {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    method: 'POST',
    body,
    model: body.model,
  })

  const jobId = payload && typeof payload === 'object' ? payload.id : null
  if (typeof jobId !== 'string' || jobId === '') {
    throw new ArkError('方舟接受了任务请求但没有返回任务 id（响应中缺少 id 字段）。', {
      code: 'MalformedResponse',
      raw: payload,
    })
  }
  return { jobId, raw: payload }
}

/**
 * 查询任务状态。
 *
 * `state` 已归一化；`videoUrl` / `lastFrameUrl` 可能为 null——`content.last_frame_url`
 * 在未请求 `returnLastFrame` 时**不存在**，不要假设它总在。
 *
 * @param {string} jobId - `submit` 返回的任务 id。
 * @param {object} options - 调用参数。
 * @param {string} options.apiKey - 方舟 API Key，必填。
 * @param {string} [options.baseUrl] - 接入点。
 * @param {string} [options.model] - 模型 id，仅用于把错误翻译得更准确。
 * @returns {Promise<{state: 'pending'|'running'|'succeeded'|'failed'|'expired'|'cancelled'|'unknown', videoUrl: string|null, lastFrameUrl: string|null, error: {code: string|null, message: string|null}|null, raw: object, usage: object|null, seed: number|null, duration: number|null, resolution: string|null, ratio: string|null}>}
 *   任务快照。
 */
export async function poll(jobId, options = {}) {
  if (typeof jobId !== 'string' || jobId.trim() === '') {
    throw new ArkError('poll 需要一个非空的任务 id。', { code: 'InvalidArgument' })
  }
  const payload = await request(`/contents/generations/tasks/${encodeURIComponent(jobId.trim())}`, {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
  })

  return {
    state: normalizeState(payload?.status),
    videoUrl: textOrNull(payload?.content?.video_url),
    lastFrameUrl: textOrNull(payload?.content?.last_frame_url),
    error: normalizeJobError(payload?.error),
    raw: payload,
    usage: payload?.usage ?? null,
    seed: payload?.seed ?? null,
    duration: payload?.duration ?? null,
    resolution: payload?.resolution ?? null,
    ratio: payload?.ratio ?? null,
  }
}

/**
 * 提交 + 轮询 + 下载落盘，一条龙。
 *
 * 之所以必须一条龙：结果 URL 是 24 小时过期的 TOS 预签名链接，
 * 把 URL 交给上层而不落盘，等于把成片放在一个会自己消失的地方。
 *
 * @param {object} spec - 生成规格。
 * @param {string} spec.model - 方舟模型 id，必填；不要硬编码，先用 {@link listModels} 核对。
 * @param {string} spec.prompt - 提示词，必填。
 * @param {'text-to-video'|'image-to-video'|'first-last-frame'} [spec.mode] - 生成模式；缺省时按
 *   `lastFrame` → `first-last-frame`、`reference` → `image-to-video`、否则 `text-to-video` 推断。
 * @param {string} [spec.reference] - 首帧图片：本地路径、`http(s)://` 或 `data:` URL。
 * @param {string} [spec.lastFrame] - 末帧图片，`first-last-frame` 模式必填。
 * @param {number} [spec.duration] - 时长（秒）。**取值域按模型不同**（实测 2.0 系 t2v 为 4–15），本模块不代填、不越界校验。
 * @param {'480p'|'720p'|'1080p'|'4k'} [spec.resolution] - 分辨率。
 * @param {'16:9'|'9:16'|'1:1'|'4:3'|'3:4'|'21:9'|'adaptive'} [spec.ratio] - 画幅。
 * @param {number} [spec.seed] - 随机种子，`-1` 为随机。
 * @param {boolean} [spec.watermark] - 是否保留方舟水印；显式 `false` 时由上层自行承担 AI 内容标识义务。
 * @param {boolean} [spec.cameraFixed] - 固定机位。
 * @param {boolean} [spec.generateAudio] - 生成同步音频。
 * @param {boolean} [spec.draft] - 草稿档。
 * @param {boolean} [spec.returnLastFrame] - 额外返回末帧，用于续写下一个镜头。
 * @param {string} [spec.serviceTier] - 服务档位。**默认不传**：2.0 / 2.0-fast / 2.0-mini 全系不支持，传了就报错。
 * @param {string} [spec.sceneId] - 场景 id，用于生成默认文件名。
 * @param {object} options - 调用参数。
 * @param {string} options.apiKey - 方舟 API Key，必填。
 * @param {string} [options.baseUrl] - 接入点。
 * @param {string} [options.outDir] - 落盘目录，默认 `'generated'`；相对路径按进程工作目录解析。
 * @param {string} [options.fileName] - 文件名，默认 `<sceneId 或 jobId>.mp4`；无扩展名时补 `.mp4`。
 * @param {number} [options.pollIntervalSeconds] - 轮询间隔，默认 15 秒。
 * @param {number} [options.maxWaitSeconds] - 最长等待，默认 900 秒；超时抛 {@link ArkError}。
 * @param {(event: {phase: string, attempt?: number, elapsedSeconds?: number, state?: string, message?: string}) => void} [options.onProgress]
 *   进度回调：提交后一次（`submitted`），**每次轮询后**一次（`polling`），下载前后各一次。
 * @returns {Promise<{localPath: string, jobId: string, state: string, videoUrl: string, lastFrameUrl: string|null, usage: object|null, seed: number|null, duration: number|null, resolution: string|null, ratio: string|null, pollCount: number, elapsedSeconds: number}>}
 *   落盘路径与最终任务快照。
 */
export async function generate(spec, options = {}) {
  const outDir = typeof options.outDir === 'string' && options.outDir.trim() !== '' ? options.outDir : 'generated'
  const pollIntervalSeconds = numberOr(options.pollIntervalSeconds, 15)
  const maxWaitSeconds = numberOr(options.maxWaitSeconds, 900)
  const emit = createEmitter(options.onProgress)
  const startedAt = Date.now()
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000)

  emit({
    phase: 'submitting',
    elapsedSeconds: 0,
    message: `提交方舟生成任务（模型 ${spec?.model ?? '未指定'}）`,
  })
  const { jobId, raw } = await submit(spec, { apiKey: options.apiKey, baseUrl: options.baseUrl })
  emit({
    phase: 'submitted',
    elapsedSeconds: elapsed(),
    state: normalizeState(raw?.status),
    message: `任务已提交：${jobId}`,
  })

  const deadline = startedAt + maxWaitSeconds * 1000
  let pollCount = 0
  let lastState = 'unknown'
  let snapshot = null

  for (;;) {
    if (Date.now() >= deadline) throw timeoutError(jobId, lastState, maxWaitSeconds)

    snapshot = await poll(jobId, { apiKey: options.apiKey, baseUrl: options.baseUrl, model: spec?.model })
    pollCount += 1
    lastState = snapshot.state
    emit({
      phase: 'polling',
      attempt: pollCount,
      elapsedSeconds: elapsed(),
      state: lastState,
      message: `任务 ${jobId} 状态：${lastState}`,
    })

    if (lastState === 'succeeded') break
    if (lastState === 'failed' || lastState === 'expired' || lastState === 'cancelled') {
      throw jobFailureError(jobId, snapshot)
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw timeoutError(jobId, lastState, maxWaitSeconds)
    await sleep(Math.min(pollIntervalSeconds * 1000, remainingMs))
  }

  const videoUrl = snapshot.videoUrl
  if (videoUrl === null) {
    throw new ArkError(`任务 ${jobId} 已成功，但响应里没有 content.video_url，无法下载结果。`, {
      code: 'MalformedResponse',
      jobId,
      raw: snapshot.raw,
    })
  }
  const lastFrameNote =
    snapshot.lastFrameUrl === null ? '' : `；同时返回末帧 URL，可用于续写下一段：${snapshot.lastFrameUrl}`

  const directory = resolve(outDir)
  await mkdir(directory, { recursive: true })
  const localPath = join(directory, outputName(options.fileName, spec, jobId))

  emit({
    phase: 'downloading',
    elapsedSeconds: elapsed(),
    state: lastState,
    message: `下载生成结果并落盘（预签名 URL 24 小时后过期）：${localPath}${lastFrameNote}`,
  })
  await downloadTo(videoUrl, localPath)
  emit({ phase: 'downloaded', elapsedSeconds: elapsed(), state: lastState, message: `已保存：${localPath}` })

  return {
    localPath,
    jobId,
    state: lastState,
    videoUrl,
    lastFrameUrl: snapshot.lastFrameUrl,
    usage: snapshot.usage,
    seed: snapshot.seed,
    duration: snapshot.duration,
    resolution: snapshot.resolution,
    ratio: snapshot.ratio,
    pollCount,
    elapsedSeconds: elapsed(),
  }
}

/* ------------------------------------------------------------------ *
 * 内部实现
 * ------------------------------------------------------------------ */

/**
 * 图像生成：`POST /images/generations`，**同步返回**，没有提交/轮询两段。
 *
 * 与视频端点的三处关键差异（均已实测）：
 *   - 同步：一次请求直接拿到结果，`generateVideo` 那套轮询在这里不适用
 *   - 尺寸是一等参数：预设字符串（`1k` / `2K`）或 `WxH`，并有**面积上下限**
 *   - 返回体是 `data[0] = { url, size, output_format }`，`url` 同样是 24 小时过期的
 *     TOS 预签名链接，所以必须立刻下载
 *
 * @param {object} spec - 生成规格。
 * @param {string} spec.prompt - 画面描述，必填。
 * @param {string} [spec.size] - `'1k'` / `'2K'` 这类预设，或 `'WIDTHxHEIGHT'`。缺省交给服务端。
 * @param {boolean} [spec.watermark] - 是否保留水印；未给就不出现在请求体里。
 * @param {number} [spec.seed] - 随机种子，-1 为随机。
 * @param {string} [spec.model] - 覆盖默认模型。
 * @param {object} [options] - 调用参数。
 * @param {string} options.apiKey - 方舟 API Key，必填。
 * @param {string} [options.baseUrl] - 接入点。
 * @param {string} [options.outDir] - 下载目录，默认 `'generated'`。
 * @param {string} [options.fileName] - 目标文件名，缺省按模型与时间生成。
 * @param {(event: {phase: string, message?: string}) => void} [options.onProgress] - 进度回调。
 * @returns {Promise<{localPath: string, url: string, size: string|null, outputFormat: string|null, usage: object|null, model: string, resolvedParams: object}>}
 * @throws {ArkError} 当参数非法、鉴权失败、模型不可用或下载失败时抛出。
 */
export async function generateImage(spec = {}, options = {}) {
  const prompt = textOrNull(spec.prompt)
  if (prompt === null) throw new ArkError('generateImage 需要 spec.prompt。', { code: 'InvalidRequest' })

  const model = textOrNull(spec.model) ?? textOrNull(options.model) ?? DEFAULT_IMAGE_MODEL
  if (!IMAGE_MODELS.includes(model)) {
    // Not fatal — the catalogue changes — but a model that is not a known image model is
    // far more likely to be a video model id, which would fail confusingly at the server.
    options.onProgress?.({
      phase: 'warning',
      message: `${model} 不在已知的图像模型列表里（${IMAGE_MODELS.join(', ')}）。如果服务端报模型错误，请先调用 listModels({filter:'seedream'}) 核对。`,
    })
  }

  const body = { model, prompt }
  // Only explicitly supplied fields are sent, matching the video path: a parameter the
  // caller did not ask for must not silently change the picture or the bill.
  if (spec.size !== undefined && spec.size !== null && spec.size !== '') {
    body.size = assertImageSize(spec.size)
  }
  if (typeof spec.watermark === 'boolean') body.watermark = spec.watermark
  if (typeof spec.seed === 'number' && Number.isFinite(spec.seed)) body.seed = spec.seed
  if (spec.responseFormat === 'url' || spec.responseFormat === 'b64_json') {
    body.response_format = spec.responseFormat
  }

  options.onProgress?.({ phase: 'generating', message: `${model} ${body.size ?? '(默认尺寸)'}` })
  const payload = await request('/images/generations', {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    method: 'POST',
    body,
    model,
  })

  const item = Array.isArray(payload?.data) ? payload.data[0] : null
  if (item === null || typeof item !== 'object') {
    throw new ArkError('方舟返回了图像响应，但没有 data[0]。', { code: 'MalformedResponse', raw: payload })
  }

  const size = textOrNull(item.size)
  const outputFormat = textOrNull(item.output_format)
  const url = textOrNull(item.url)

  // `response_format: 'b64_json'` puts the bytes inline instead of a URL. Both are handled
  // because which one arrives depends on the parameter, not on the caller's intent.
  const inline = textOrNull(item.b64_json)
  if (url === null && inline === null) {
    throw new ArkError('图像响应里既没有 url 也没有 b64_json。', { code: 'MalformedResponse', raw: payload })
  }

  const outDir = typeof options.outDir === 'string' && options.outDir !== '' ? options.outDir : 'generated'
  const target = join(
    outDir,
    options.fileName !== undefined && options.fileName !== ''
      ? ensureImageExtension(options.fileName, outputFormat)
      : defaultImageName(model, outputFormat),
  )
  await mkdir(outDir, { recursive: true })

  options.onProgress?.({ phase: 'downloading', message: target })
  if (inline !== null) {
    await writeFile(target, Buffer.from(inline, 'base64'))
  } else {
    // The URL is a 24-hour presigned link, so it is fetched now rather than handed back.
    await downloadTo(url, target)
  }

  options.onProgress?.({ phase: 'downloaded', message: target })
  return {
    localPath: target,
    url,
    size,
    outputFormat,
    usage: payload?.usage ?? null,
    model: textOrNull(payload?.model) ?? model,
    resolvedParams: body,
  }
}

/**
 * 校验尺寸，并给出可操作的建议。
 *
 * 服务端只报「不合法」，不说合法范围。这里把实测到的面积上下限写成客户端校验，让错误在
 * 花钱之前就出现。
 *
 * @param {string} size - 调用方给的尺寸。
 * @returns {string} 原样返回合法的尺寸。
 * @throws {ArkError} 当尺寸形态或面积越界时抛出。
 */
export function assertImageSize(size) {
  const text = String(size).trim()
  if (/^\d+x\d+$/i.test(text) === false) {
    // Presets are short tokens such as `1k` or `2K`; the server accepts those, so anything
    // that is neither a WxH pair nor a short token is refused here.
    if (/^[0-9]+k$/i.test(text)) return text
    throw new ArkError(
      `size 必须是 'WIDTHxHEIGHT'（如 '1024x1024'）或预设字符串（如 '1k'、'2K'），收到 '${size}'。`,
      { code: 'InvalidParameter' },
    )
  }
  const [width, height] = text.toLowerCase().split('x').map(Number)
  const area = width * height
  if (area < IMAGE_MIN_PIXELS) {
    throw new ArkError(
      `size '${size}' 太小：图像面积至少 ${IMAGE_MIN_PIXELS} 像素（实测下限，约 960x960）。`,
      { code: 'InvalidParameter' },
    )
  }
  if (area > IMAGE_MAX_PIXELS) {
    throw new ArkError(
      `size '${size}' 太大：图像面积至多 ${IMAGE_MAX_PIXELS} 像素（实测上限，约 2K 级别）。`,
      { code: 'InvalidParameter' },
    )
  }
  return text
}

/**
 * Give a filename the extension that matches what the provider actually returned.
 *
 * The provider's `output_format` wins over whatever the caller guessed. Trusting the
 * caller's extension produced `cover.png` holding JPEG bytes, which misleads every later
 * step that branches on the extension — and `classify()` in the material scanner does
 * exactly that.
 *
 * @param {string} fileName - the caller's filename, with or without an extension.
 * @param {string|null} outputFormat - what the provider reported, for example `'jpeg'`.
 * @returns {string} a filename whose extension matches the content.
 */
function ensureImageExtension(fileName, outputFormat) {
  const wanted = extensionFor(outputFormat)
  const existing = extname(fileName).replace(/^\./, '').toLowerCase()
  const equivalent =
    (existing === 'jpg' || existing === 'jpeg') && (wanted === 'jpg' || wanted === 'jpeg')
  if (existing !== '' && (existing === wanted || equivalent)) return fileName
  // Drop a wrong extension rather than appending a second one (`cover.png.jpg`).
  const stem = existing === '' ? fileName : fileName.slice(0, -(existing.length + 1))
  return `${stem}.${wanted}`
}

/**
 * 由服务端报告的格式得到扩展名。
 * @param {string|null} outputFormat - `'jpeg'`、`'png'` 等。
 * @returns {string} 扩展名，不含点。
 */
function extensionFor(outputFormat) {
  const format = (outputFormat ?? 'jpeg').toLowerCase()
  if (format === 'jpeg' || format === 'jpg') return 'jpg'
  if (format === 'png') return 'png'
  if (format === 'webp') return 'webp'
  return format
}

/**
 * 缺省文件名：模型名加时间戳，因为图像生成不返回任务 id。
 * @param {string} model - 模型 id。
 * @param {string|null} outputFormat - 服务端报告的格式。
 * @returns {string} 文件名。
 */
function defaultImageName(model, outputFormat) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `seedream-${stamp}.${extensionFor(outputFormat)}`
}

/**
 * 发一个方舟请求：统一鉴权、统一解析、统一把失败翻译成 {@link ArkError}。
 *
 * @param {string} path - 以 `/` 开头的路径（含查询串）。
 * @param {object} options - 请求选项。
 * @param {string} options.apiKey - API Key。
 * @param {string} [options.baseUrl] - 接入点。
 * @param {string} [options.method] - HTTP 方法，默认 GET。
 * @param {any} [options.body] - 请求体，会被 JSON 序列化。
 * @param {string} [options.model] - 模型 id，仅用于错误翻译。
 * @returns {Promise<any>} 解析后的响应体（空响应为 null）。
 */
async function request(path, options = {}) {
  const apiKey = requireApiKey(options.apiKey)
  const url = `${baseUrlOf(options.baseUrl)}${path}`
  const init = {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)

  let response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    throw new ArkError(`无法连接方舟接口${url}：${cause?.message ?? cause}`, {
      code: 'NetworkError',
      cause,
    })
  }

  const text = await response.text()
  let payload = null
  if (text.trim() !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  if (!response.ok) throw arkErrorFrom(response, payload, options)
  return payload
}

/**
 * 校验并返回 API Key。本模块只从参数拿 Key，不读环境变量。
 * @param {any} apiKey - 调用方传入的 Key。
 * @returns {string} 去空白后的 Key。
 */
function requireApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new ArkError(
      `缺少 apiKey：请在 options.apiKey 里显式传入方舟 API Key（通常来自环境变量 ${DEFAULT_KEY_ENV}）。`,
      { code: 'AuthenticationError', status: 401 },
    )
  }
  return apiKey.trim()
}

/**
 * 归一化接入点：空值回落默认值，去掉结尾斜杠。
 * @param {any} baseUrl - 调用方传入的接入点。
 * @returns {string} 可拼接的接入点。
 */
function baseUrlOf(baseUrl) {
  const value = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : DEFAULT_BASE_URL
  return value.replace(/\/+$/, '')
}

/**
 * 把服务端错误翻译成人话。
 *
 * 关键点：`ModelNotOpen` 与 `InvalidEndpointOrModel.NotFound` 都是 HTTP 404，
 * 但含义完全不同（未开通 vs 不存在/不可见），**不允许把裸 404 抛给上层**。
 *
 * @param {Response} response - fetch 响应。
 * @param {any} payload - 已解析的响应体。
 * @param {object} [context] - 上下文，`model` 用于补全模型 id。
 * @returns {ArkError} 分类后的错误。
 */
function arkErrorFrom(response, payload, context = {}) {
  const envelope = payload && typeof payload === 'object' ? payload : {}
  const error = envelope.error && typeof envelope.error === 'object' ? envelope.error : envelope
  const code = typeof error?.code === 'string' ? error.code : null
  const rawMessage = String(error?.message ?? envelope.message ?? response.statusText ?? '').trim()
  const serverMessage = rawMessage.replace(/\s*Request id:\s*[\w.-]+\s*$/i, '').trim()
  const status = response.status
  const requestId = firstString(
    error?.request_id,
    error?.requestId,
    envelope.request_id,
    /Request id:\s*([\w.-]+)/i.exec(rawMessage)?.[1],
  )
  const model = firstString(context.model, /model\s+([\w.\-]+)/i.exec(serverMessage)?.[1])
  const details = { code, status, requestId, raw: payload, model }

  if (status === 401 || code === 'AuthenticationError') {
    return new ArkError(
      `方舟鉴权失败（HTTP ${status || 401}）：${serverMessage || '服务端未给出原因'}。` +
        `请确认已通过 options.apiKey 传入有效的方舟 API Key（环境变量名通常是 ${DEFAULT_KEY_ENV}）。`,
      { ...details, code: code ?? 'AuthenticationError', status: status || 401 },
    )
  }

  if (code === 'ModelNotOpen') {
    return new ArkError(
      `模型 ${model ?? '(未提供)'} 存在于方舟但本账号未开通，请到方舟控制台激活该模型后重试。` +
        `服务端信息：${serverMessage || '(无)'}`,
      details,
    )
  }

  if (code === 'InvalidEndpointOrModel.NotFound') {
    return new ArkError(
      `方舟找不到模型 ${model ?? '(未提供)'}（模型不存在，或本账号/本区域不可见）。` +
        `请先调用 listModels({ apiKey }) 核对可用的模型 id。服务端信息：${serverMessage || '(无)'}`,
      details,
    )
  }

  if (code === 'InvalidParameter') {
    return new ArkError(
      `方舟拒绝了请求参数（模型 ${model ?? '(未提供)'}；参数支持按「模型 + 模式」分别限定）：` +
        `${serverMessage || '(服务端未指明字段)'}`,
      details,
    )
  }

  return new ArkError(
    `方舟接口报错（code=${code ?? '未知'}，HTTP ${status}）：${serverMessage || '服务端未提供错误信息'}`,
    details,
  )
}

/**
 * 由 `spec` 构造请求体。
 * @param {object} spec - 生成规格。
 * @returns {{body: object, mode: string}} 请求体与解析出的模式。
 */
function buildRequestBody(spec = {}) {
  const model = spec?.model
  if (typeof model !== 'string' || model.trim() === '') {
    throw new ArkError(
      '缺少 spec.model：必须显式指定方舟模型 id（例如 doubao-seedance-2-0-260128）。' +
        '不要硬编码，先用 listModels 核对当前账号可见且在售的模型。',
      { code: 'InvalidArgument' },
    )
  }

  const mode = resolveMode(spec)
  const body = { model: model.trim(), content: buildContent(spec, mode) }

  for (const [from, to] of OPTIONAL_FIELDS) {
    const value = spec[from]
    // 未显式提供 → 绝不放进请求体。2.0 系收到 service_tier 会直接报错。
    if (value === undefined || value === null) continue
    body[to] = value
  }

  return { body, mode }
}

/**
 * 判定生成模式：显式 `mode` 优先，否则从图片字段推断。
 * @param {object} spec - 生成规格。
 * @returns {string} 模式。
 */
function resolveMode(spec) {
  const declared = spec?.mode
  if (declared !== undefined && declared !== null && declared !== '') {
    if (!MODES.includes(declared)) {
      throw new ArkError(`未知的 spec.mode：${declared}。合法取值：${MODES.join(' / ')}。`, {
        code: 'InvalidArgument',
      })
    }
    return declared
  }
  if (spec?.lastFrame) return 'first-last-frame'
  if (spec?.reference) return 'image-to-video'
  return 'text-to-video'
}

/**
 * 组装 `content` 数组：text 必有，图片按模式追加，并带上 `role`。
 * @param {object} spec - 生成规格。
 * @param {string} mode - 生成模式。
 * @returns {object[]} content 数组。
 */
function buildContent(spec, mode) {
  if (typeof spec.prompt !== 'string' || spec.prompt.trim() === '') {
    throw new ArkError('缺少 spec.prompt：方舟视频生成需要一段文字提示词。', { code: 'InvalidArgument' })
  }
  const content = [{ type: 'text', text: spec.prompt }]

  if (mode === 'text-to-video') {
    if (spec.reference || spec.lastFrame) {
      throw new ArkError('mode 为 text-to-video 时不应提供 reference / lastFrame，请改用 image-to-video 或 first-last-frame。', {
        code: 'InvalidArgument',
      })
    }
    return content
  }

  if (!spec.reference) {
    throw new ArkError(`mode 为 ${mode} 时必须提供 spec.reference 作为首帧图片（本地路径或 URL）。`, {
      code: 'InvalidArgument',
    })
  }
  content.push({
    type: 'image_url',
    image_url: { url: imageToUrl(spec.reference, 'reference') },
    role: 'first_frame',
  })

  if (mode === 'image-to-video') {
    if (spec.lastFrame) {
      throw new ArkError('mode 为 image-to-video 时不应提供 lastFrame，请把 mode 改成 first-last-frame。', {
        code: 'InvalidArgument',
      })
    }
    return content
  }

  if (!spec.lastFrame) {
    throw new ArkError('mode 为 first-last-frame 时必须同时提供 spec.lastFrame 作为末帧图片。', {
      code: 'InvalidArgument',
    })
  }
  content.push({
    type: 'image_url',
    image_url: { url: imageToUrl(spec.lastFrame, 'lastFrame') },
    role: 'last_frame',
  })

  return content
}

/**
 * 图片引用 → 方舟可接受的 URL：`http(s)://` 与 `data:` 原样传递，本地路径转 base64 data URL。
 * @param {string} value - 图片引用。
 * @param {string} field - 字段名，用于报错。
 * @returns {string} URL 或 data URL。
 */
function imageToUrl(value, field) {
  const text = String(value).trim()
  if (/^https?:\/\//i.test(text) || /^data:/i.test(text)) return text

  const absolute = resolve(text)
  if (!existsSync(absolute)) {
    throw new ArkError(`spec.${field} 指向的本地图片不存在：${absolute}`, { code: 'InvalidArgument' })
  }
  const extension = extname(absolute).toLowerCase()
  const mime = MIME_BY_EXTENSION.get(extension)
  if (mime === undefined) {
    throw new ArkError(
      `spec.${field} 的图片扩展名 ${extension === '' ? '(无)' : extension} 不受支持；` +
        `可用扩展名：${[...MIME_BY_EXTENSION.keys()].join(' / ')}。`,
      { code: 'InvalidArgument' },
    )
  }
  return `data:${mime};base64,${readFileSync(absolute).toString('base64')}`
}

/**
 * 校验 API Key 后下载结果文件。
 * @param {string} url - 预签名结果 URL。
 * @param {string} target - 落盘绝对路径。
 * @returns {Promise<void>} 写入完成。
 */
async function downloadTo(url, target) {
  let response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new ArkError(`下载生成结果失败：${cause?.message ?? cause}`, { code: 'NetworkError', cause })
  }
  if (!response.ok) {
    throw new ArkError(
      `下载生成结果失败：HTTP ${response.status}。` +
        '结果 URL 是 24 小时过期的 TOS 预签名链接，过期后只能重新生成。',
      { code: 'DownloadFailed', status: response.status },
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) throw new ArkError('下载到的生成结果为空文件，已放弃写入。', { code: 'DownloadFailed' })
  await writeFile(target, bytes)
}

/**
 * 归一化服务端 status。
 * @param {any} status - 服务端返回的 status。
 * @returns {'pending'|'running'|'succeeded'|'failed'|'expired'|'cancelled'|'unknown'} 归一化状态。
 */
function normalizeState(status) {
  if (typeof status !== 'string') return 'unknown'
  return STATE_ALIASES.get(status.trim().toLowerCase()) ?? 'unknown'
}

/**
 * 归一化任务错误字段。
 * @param {any} error - 响应里的 `error`。
 * @returns {{code: string|null, message: string|null}|null} 归一化后的错误。
 */
function normalizeJobError(error) {
  if (error === undefined || error === null) return null
  if (typeof error === 'string') return { code: null, message: error }
  if (typeof error === 'object') {
    return {
      code: typeof error.code === 'string' ? error.code : null,
      message: typeof error.message === 'string' ? error.message : null,
    }
  }
  return { code: null, message: String(error) }
}

/**
 * 判定模型可用性分档。
 * @param {any} status - `/models` 返回的 status。
 * @returns {'live'|'retiring'|'shutdown'} 分档结果。
 */
function availabilityOf(status) {
  if (status === undefined || status === null || String(status).trim() === '') return 'live'
  const value = String(status).trim().toLowerCase()
  if (value === 'retiring') return 'retiring'
  if (value === 'shutdown') return 'shutdown'
  // 未预期的取值：保守归为已下线，`status` 字段仍原样保留给上层判断。
  return 'shutdown'
}

/**
 * 造一个「轮询超时」错误。
 * @param {string} jobId - 任务 id。
 * @param {string} lastState - 最后观察到的状态。
 * @param {number} maxWaitSeconds - 配置的最长等待。
 * @returns {ArkError} 超时错误。
 */
function timeoutError(jobId, lastState, maxWaitSeconds) {
  return new ArkError(
    `轮询方舟任务 ${jobId} 超过 maxWaitSeconds=${maxWaitSeconds} 秒仍未完成，最后观察到的 state 是「${lastState}」。` +
      `任务可能仍在生成：可以稍后用 poll('${jobId}', { apiKey }) 继续查询，注意结果 URL 24 小时后过期。`,
    { code: 'PollTimeout', jobId },
  )
}

/**
 * 造一个「任务终结但未成功」错误。
 * @param {string} jobId - 任务 id。
 * @param {object} snapshot - {@link poll} 的快照。
 * @returns {ArkError} 任务失败错误。
 */
function jobFailureError(jobId, snapshot) {
  const label =
    snapshot.state === 'cancelled' ? '任务已被取消' : snapshot.state === 'expired' ? '任务已过期' : '任务失败'
  const detail = snapshot.error?.message ?? snapshot.error?.code ?? '服务端未给出错误信息'
  return new ArkError(`${label}：${jobId}。服务端信息：${detail}`, {
    code: snapshot.error?.code ?? null,
    jobId,
    raw: snapshot.raw,
  })
}

/**
 * 决定落盘文件名。
 * @param {any} fileName - 调用方指定的文件名。
 * @param {object} spec - 生成规格。
 * @param {string} jobId - 任务 id。
 * @returns {string} 文件名（不含目录）。
 */
function outputName(fileName, spec, jobId) {
  let name =
    typeof fileName === 'string' && fileName.trim() !== ''
      ? fileName.trim()
      : `${spec?.sceneId || jobId}.mp4`
  if (extname(name) === '') name += '.mp4'
  return name
}

/**
 * 包装 `onProgress`：回调抛错不能中断一个已经在花钱的任务。
 * @param {any} onProgress - 调用方回调。
 * @returns {(event: object) => void} 安全回调。
 */
function createEmitter(onProgress) {
  if (typeof onProgress !== 'function') return () => {}
  return (event) => {
    try {
      onProgress(event)
    } catch {
      /* 进度回调的异常与生成任务无关，吞掉 */
    }
  }
}

/**
 * 数字参数回退：`undefined`/`null`/非有限数回落默认值，显式 `0` 会被尊重。
 * @param {any} value - 调用方传入的值。
 * @param {number} fallback - 默认值。
 * @returns {number} 可用数值。
 */
function numberOr(value, fallback) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

/**
 * 取第一个非空字符串。
 * @param {...any} candidates - 候选值。
 * @returns {string|null} 第一个有效字符串，或 null。
 */
function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return null
}

/**
 * 取非空字符串，否则 null。
 * @param {any} value - 候选值。
 * @returns {string|null} 字符串或 null。
 */
function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 等待。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 到点后 resolve。
 */
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/* ------------------------------------------------------------------ *
 * 实证后需核对清单（模型开通后跑一次真实生成逐条核对，见设计规格 §7.3）
 *
 * 已实证：鉴权方式；四个端点；`duration` 4–15（doubao-seedance-2-0 系列 t2v）；
 *   `resolution` 480p/720p/1080p/4k；`ratio` 七种全收；`content[].role`
 *   接受 first_frame / last_frame，不带 role 也接受；`service_tier` 对 2.0 全系报
 *   "must be empty"；模型校验先于参数校验；结果 URL `X-Tos-Expires=86400`。
 * 未实证：`queued` 状态是否存在（实测只见 running -> succeeded）；
 *   `return_last_frame: true` 时是否真的返回 `content.last_frame_url`；
 *   图片格式/尺寸/体积/宽高比限制（jpeg/png/webp/bmp/tiff/gif、宽高比 0.4–2.5、
 *   每边 300–6000px、≤30MB 均为第三方说法）；`service_tier` 完整取值域；
 *   `execution_expires_after` 合法区间（3600–259200 为第三方说法）；
 *   `duration` 在 2.5 / 1.0-pro-fast 上是否同为 4–15。
 * 因此本模块**不代填、也不本地越界校验** `duration` / `serviceTier` / `executionExpiresAfter`，
 * 一律交给服务端判定，并把服务端原文带进 ArkError。
 * ------------------------------------------------------------------ */
