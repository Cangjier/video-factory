/**
 * The `video-factory` Host plugin: a set of deterministic media tools for DSH.
 *
 * The plugin is a plain ESM module with no harness import, so a profile can install
 * it without a build step and without a dependency edge on the harness packages it
 * composes with. It validates its own config, because validating through the Loader
 * would require the dependency this module exists to avoid.
 *
 * Division of labour, which the rest of the code depends on:
 *   DSH decides what the video is — scenes, order, pacing, wording.
 *   This plugin only executes: same input, same output, except for cloud generation.
 *
 * @module video-factory
 */
import { registerTools } from './src/tools/index.mjs'
import { DEFAULT_MAX_SIDE_LEN, DEFAULT_TIMEOUT_MS, IDLE_SHUTDOWN_MS, disposeOcrSessions } from './src/core/ocr.mjs'

/** Stable Cordis plugin name. */
export const name = 'video-factory'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** The verified API root for ByteDance's Volcengine Ark. */
export const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** Default Edge TTS voice. */
export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

/** Default OCR recognition language: Simplified Chinese, which still reads Latin text correctly. */
export const DEFAULT_OCR_LANGUAGE = 'ch'

/** Default OCR engine preference: the installed engine, falling back to the Windows recogniser. */
export const DEFAULT_OCR_ENGINE = 'auto'

/**
 * Read a required string field, allowing null to mean "use the default".
 * @param {object} raw - the raw config object.
 * @param {string} key - field name.
 * @param {string|null} fallback - value used when the field is absent or null.
 * @param {string} where - path used in the error message.
 * @returns {string|null} the resolved value.
 */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`video-factory: ${where} must be a string or null`)
  return value
}

/**
 * Read a positive number field.
 * @param {object} raw - the raw config object.
 * @param {string} key - field name.
 * @param {number} fallback - value used when the field is absent.
 * @param {string} where - path used in the error message.
 * @returns {number} the resolved value.
 */
function optionalPositiveNumber(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`video-factory: ${where} must be a positive number`)
  }
  return value
}

/**
 * Validate and normalize the row's config.
 *
 * Misconfiguration fails loud here, at activation, rather than surfacing later as a
 * confusing tool error.
 *
 * @param {object} [raw] - the row's `config`.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type.
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const ark = config.ark ?? {}
  const tts = config.tts ?? {}
  const ocr = config.ocr ?? {}

  return {
    projectRoot: optionalString(config, 'projectRoot', null, 'config.projectRoot'),
    ffmpegPath: optionalString(config, 'ffmpegPath', null, 'config.ffmpegPath'),
    ffprobePath: optionalString(config, 'ffprobePath', null, 'config.ffprobePath'),
    pathBudget: optionalPositiveNumber(config, 'pathBudget', 200, 'config.pathBudget'),
    ark: {
      apiKeyEnv: optionalString(ark, 'apiKeyEnv', 'ARK_API_KEY', 'config.ark.apiKeyEnv'),
      baseUrl: optionalString(ark, 'baseUrl', DEFAULT_ARK_BASE_URL, 'config.ark.baseUrl'),
      defaultModel: optionalString(ark, 'defaultModel', null, 'config.ark.defaultModel'),
      imageModel: optionalString(ark, 'imageModel', null, 'config.ark.imageModel'),
      pollIntervalSeconds: optionalPositiveNumber(ark, 'pollIntervalSeconds', 15, 'config.ark.pollIntervalSeconds'),
      maxWaitSeconds: optionalPositiveNumber(ark, 'maxWaitSeconds', 900, 'config.ark.maxWaitSeconds'),
    },
    tts: {
      voice: optionalString(tts, 'voice', DEFAULT_TTS_VOICE, 'config.tts.voice'),
      rate: optionalString(tts, 'rate', '+0%', 'config.tts.rate'),
      pitch: optionalString(tts, 'pitch', '+0Hz', 'config.tts.pitch'),
      volume: optionalString(tts, 'volume', '+0%', 'config.tts.volume'),
    },
    ocr: {
      // Everything here is optional: with no engine installed, OCR falls back to the Windows
      // recogniser and the rest of the plugin is unaffected.
      enginePath: optionalString(ocr, 'enginePath', null, 'config.ocr.enginePath'),
      kind: optionalString(ocr, 'kind', null, 'config.ocr.kind'),
      source: optionalString(ocr, 'source', null, 'config.ocr.source'),
      language: optionalString(ocr, 'language', DEFAULT_OCR_LANGUAGE, 'config.ocr.language'),
      defaultEngine: optionalString(ocr, 'defaultEngine', DEFAULT_OCR_ENGINE, 'config.ocr.defaultEngine'),
      maxSideLen: optionalPositiveNumber(ocr, 'maxSideLen', DEFAULT_MAX_SIDE_LEN, 'config.ocr.maxSideLen'),
      timeoutMs: optionalPositiveNumber(ocr, 'timeoutMs', DEFAULT_TIMEOUT_MS, 'config.ocr.timeoutMs'),
      idleMs: optionalPositiveNumber(ocr, 'idleMs', IDLE_SHUTDOWN_MS, 'config.ocr.idleMs'),
      scale: optionalString(ocr, 'scale', null, 'config.ocr.scale'),
    },
  }
}

/**
 * Mount the tools.
 *
 * Registration is wrapped so a failure to reach the `tools` service is logged
 * clearly instead of looking like a silent no-op: a plugin that loads but exposes
 * nothing is the hardest kind of failure to notice.
 *
 * @param {object} ctx - plugin context.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`video-factory: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  ctx.inject(['tools'], (toolsCtx) => {
    // Host services are looked up through the plugin's own context on every call.
    // `speechToText` is deliberately NOT in `inject`: transcription is one optional
    // action, and requiring the service would stop the plugin loading on any profile
    // that has not enabled the speech bundle.
    //
    // `ctx.get` is optional because a minimal composition need not provide a service
    // locator; without one, only transcription is unavailable.
    const getService =
      typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
    const outcome = registerTools(toolsCtx, config, ctx.logger, { getService })
    if (outcome.registered.length === 0) {
      ctx.logger.error('video-factory: 没有注册任何工具，插件实际上不可用')
    }
  })

  // A warm OCR engine is a real process holding hundreds of megabytes; it must not outlive the
  // plugin that started it. `on` is optional because a minimal composition need not expose it.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      disposeOcrSessions()
    })
  }
}
