/**
 * The edit plan: schema, validation, and timeline arithmetic.
 *
 * plan.json is the single contract between DSH and this plugin. DSH writes it; this
 * module only judges it. Validation never repairs anything — {@link parsePlan}
 * either returns a plan or throws naming the offending field, and the defaults it
 * applies are exactly the documented ones, so a plan that omits `fit` gets `cover`
 * and nothing more.
 *
 * @module video-factory/core/plan
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Schema version this build understands. */
export const PLAN_VERSION = 1

/** Named canvas presets. */
export const PRESETS = {
  'vertical-short': { width: 1080, height: 1920, fps: 30, label: '竖屏短视频 9:16' },
  horizontal: { width: 1920, height: 1080, fps: 30, label: '横屏 16:9' },
  square: { width: 1080, height: 1080, fps: 30, label: '方形 1:1' },
  'landscape-4k': { width: 3840, height: 2160, fps: 30, label: '横屏 4K' },
  preview: { width: 640, height: 360, fps: 24, label: '快速预览' },
}

/** Still-image motion types. */
export const MOTION_TYPES = ['none', 'kenburns', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']

/**
 * How a matte's mask moves between the frames it was computed for.
 *
 * Declared here rather than imported from `matte.mjs` because that module reaches `probe.mjs` and
 * therefore back into this one; the values are the same list, and `tests/matte.test.mjs` asserts
 * they have not drifted apart. The plan schema must be buildable without pulling in the renderer.
 */
export const MATTE_INTERPOLATION_MODES = ['hold', 'blend']

/** Transition types ffmpeg's xfade understands, plus `none`. */
export const TRANSITION_TYPES = [
  'none', 'fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight',
  'slideleft', 'slideright', 'smoothleft', 'circleopen', 'dissolve',
]

/** Scene kinds. */
export const SCENE_KINDS = ['image', 'video', 'color', 'generated']

/** How a source is mapped onto the canvas. */
export const FIT_TYPES = ['cover', 'contain', 'blur-pad']

/** The nine overlay anchors. */
export const ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

/** Encoder settings per quality tier. */
export const QUALITY = {
  high: { crf: 18, preset: 'medium', audioBitrate: '192k' },
  medium: { crf: 21, preset: 'medium', audioBitrate: '160k' },
  draft: { crf: 27, preset: 'veryfast', audioBitrate: '128k' },
}

/** Raised when a plan is structurally invalid or references a missing file. */
export class PlanError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanError'
  }
}

/**
 * Require a present, non-empty field.
 * @param {object} mapping - the object to read.
 * @param {string} key - field name.
 * @param {string} where - location used in the error message.
 * @returns {*} the value.
 */
function requireField(mapping, key, where) {
  const value = mapping[key]
  if (value === undefined || value === null || value === '') {
    throw new PlanError(`${where}: missing required field '${key}'`)
  }
  return value
}

/**
 * Read a number and bound it.
 *
 * Booleans are rejected on purpose: `true` is not a duration, and silently
 * accepting it would turn a typo into a 1-second scene.
 * @param {*} value - candidate value.
 * @param {string} where - location used in the error message.
 * @param {number} [minimum] - inclusive lower bound.
 * @param {number} [maximum] - inclusive upper bound.
 * @returns {number} the validated number.
 */
function numberField(value, where, minimum, maximum) {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PlanError(`${where}: expected a number, got ${typeof value}`)
  }
  if (minimum !== undefined && value < minimum) {
    throw new PlanError(`${where}: ${value} is below the minimum ${minimum}`)
  }
  if (maximum !== undefined && value > maximum) {
    throw new PlanError(`${where}: ${value} is above the maximum ${maximum}`)
  }
  return value
}

/**
 * Read an enum-valued field.
 *
 * The label makes the message name the concept, not just the field path: "unknown
 * motion 'spin'" tells the model what kind of value it should have supplied.
 * @param {*} value - candidate value.
 * @param {string[]} allowed - legal values.
 * @param {string} where - location used in the error message.
 * @param {string} label - the concept being validated, for example `motion`.
 * @returns {string} the validated value.
 */
function enumField(value, allowed, where, label) {
  if (!allowed.includes(value)) {
    throw new PlanError(`${where}: unknown ${label} '${value}'; expected one of ${allowed.join(', ')}`)
  }
  return value
}

/**
 * Parse a scene's chroma-key block.
 *
 * Returns `null` when absent, which is what {@link module:video-factory/core/filter.chromaKeyFilter}
 * expects for "no key". Validation of the numbers lives in the filter module, because that is
 * where they are consumed and where the resolved values are reported; duplicating the ranges
 * here would create two places to change and one of them would eventually be missed.
 *
 * @param {object|undefined} raw - the decoded block.
 * @param {string} where - location used in the error message.
 * @returns {object|null} the block, or null when the scene is not keyed.
 */
function parseChromaKey(raw, where) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanError(`${where}: expected an object like { color, similarity, blend, spill }`)
  }
  const block = {
    color: raw.color === undefined || raw.color === null ? '#00B140' : String(raw.color),
    similarity: raw.similarity === undefined ? undefined : numberField(raw.similarity, `${where}.similarity`, 0.01, 1),
    blend: raw.blend === undefined ? undefined : numberField(raw.blend, `${where}.blend`, 0, 1),
    spill: raw.spill === undefined ? undefined : Boolean(raw.spill),
    despill: raw.despill === undefined ? undefined : Boolean(raw.despill),
    // A key without a background produces transparency that the render drops on the floor, so
    // this is the field that makes the feature do anything. It is optional because a caller may
    // want the keyed frame for a later step instead.
    background: raw.background === undefined || raw.background === null ? null : String(raw.background),
  }
  if (block.similarity !== undefined && block.blend !== undefined && block.similarity + block.blend > 1) {
    throw new PlanError(
      `${where}: similarity (${block.similarity}) + blend (${block.blend}) must not exceed 1`,
    )
  }
  return block
}

/**
 * Parse a scene's learned-matting block.
 *
 * The `mask_fps` field is the whole point of this block and is deliberately left without a
 * creative default: it is the trade between how smooth the mask edge moves and how long the
 * render takes, and that judgement belongs to whoever is planning the cut. The plugin executes
 * the rate it is given and reports what the rate cost.
 *
 * @param {object|undefined} raw - the decoded block.
 * @param {string} where - location used in the error message.
 * @returns {object|null} the block, or null when the scene is not matted.
 */
function parseMatte(raw, where) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanError(`${where}: expected an object like { mask_fps, background, feather }`)
  }
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled)
  return {
    enabled,
    model: raw.model === undefined || raw.model === null ? 'u2netp' : String(raw.model),
    maskFps: raw.mask_fps === undefined ? 8 : numberField(raw.mask_fps, `${where}.mask_fps`, 0.5, 30),
    // How the mask moves between the frames it is computed for. `hold` repeats it, which is what
    // the rate literally means; `blend` cross-fades, which is what makes a low rate usable.
    interpolate:
      raw.interpolate === undefined
        ? 'hold'
        : enumField(raw.interpolate, MATTE_INTERPOLATION_MODES, `${where}.interpolate`, 'interpolate'),
    background: raw.background === undefined || raw.background === null ? null : String(raw.background),
    feather: raw.feather === undefined ? 0 : numberField(raw.feather, `${where}.feather`, 0, 24),
  }
}

/**
 * Parse one text overlay.
 * @param {object} raw - the decoded overlay.
 * @param {string} where - location used in the error message.
 * @returns {object} the validated overlay.
 */
function parseOverlay(raw, where) {
  if (raw === null || typeof raw !== 'object') throw new PlanError(`${where}: expected an object`)
  const end = raw.end
  return {
    text: String(requireField(raw, 'text', where)),
    anchor: raw.anchor === undefined ? 'bottom-center' : enumField(raw.anchor, ANCHORS, `${where}.anchor`, 'anchor'),
    fontSize: raw.font_size === undefined ? 48 : numberField(raw.font_size, `${where}.font_size`, 8, 400),
    color: raw.color === undefined ? '#FFFFFF' : String(raw.color),
    box: raw.box === undefined ? true : Boolean(raw.box),
    margin: raw.margin === undefined ? 80 : numberField(raw.margin, `${where}.margin`, 0, 2000),
    start: raw.start === undefined ? 0 : numberField(raw.start, `${where}.start`, 0),
    end: end === undefined || end === null ? null : numberField(end, `${where}.end`, 0),
  }
}

/**
 * Parse one transition.
 * @param {object|undefined} raw - the decoded transition.
 * @param {string} where - location used in the error message.
 * @returns {{type: string, duration: number}} the validated transition.
 */
function parseTransition(raw, where) {
  if (raw === undefined || raw === null) return { type: 'none', duration: 0.5 }
  if (typeof raw !== 'object') throw new PlanError(`${where}: expected an object`)
  const type = raw.type === undefined ? 'none' : enumField(raw.type, TRANSITION_TYPES, `${where}.type`, 'transition')
  const duration = raw.duration === undefined ? 0.5 : numberField(raw.duration, `${where}.duration`, 0, 5)
  return { type, duration }
}

/**
 * Parse a cloud-generation request.
 * @param {object} raw - the decoded `generate` block.
 * @param {string} where - location used in the error message.
 * @returns {object} the validated generation spec.
 */
function parseGeneration(raw, where) {
  if (raw === null || typeof raw !== 'object') throw new PlanError(`${where}: expected an object`)
  const mode = raw.mode === undefined ? 'text-to-video' : String(raw.mode)
  if (!['text-to-video', 'image-to-video', 'first-last-frame'].includes(mode)) {
    throw new PlanError(`${where}.mode: expected text-to-video, image-to-video, or first-last-frame; got '${mode}'`)
  }
  return {
    provider: raw.provider === undefined ? 'ark' : String(raw.provider),
    mode,
    prompt: String(requireField(raw, 'prompt', where)),
    reference: raw.reference === undefined || raw.reference === null ? null : String(raw.reference),
    lastFrame: raw.last_frame === undefined || raw.last_frame === null ? null : String(raw.last_frame),
    duration: raw.duration === undefined ? 5 : numberField(raw.duration, `${where}.duration`, 1, 60),
    resolution: raw.resolution === undefined ? '720p' : String(raw.resolution),
    ratio: raw.ratio === undefined || raw.ratio === null ? null : String(raw.ratio),
    model: raw.model === undefined || raw.model === null ? null : String(raw.model),
    seed: raw.seed === undefined || raw.seed === null ? -1 : numberField(raw.seed, `${where}.seed`),
    watermark: raw.watermark === undefined ? true : Boolean(raw.watermark),
    serviceTier: raw.service_tier === undefined || raw.service_tier === null ? null : String(raw.service_tier),
  }
}

/**
 * Parse one scene.
 * @param {object} raw - the decoded scene.
 * @param {number} index - position in the scene list, used for default ids.
 * @returns {object} the validated scene.
 */
function parseScene(raw, index) {
  const where = `scenes[${index}]`
  if (raw === null || typeof raw !== 'object') throw new PlanError(`${where}: expected an object`)

  const generate =
    raw.generate === undefined || raw.generate === null ? null : parseGeneration(raw.generate, `${where}.generate`)
  const kind = raw.kind === undefined ? (generate === null ? 'video' : 'generated') : String(raw.kind)
  enumField(kind, SCENE_KINDS, `${where}.kind`, 'kind')

  if (kind !== 'color' && (raw.source === undefined || raw.source === null || raw.source === '') && generate === null) {
    throw new PlanError(`${where}: needs 'source', 'color', or 'generate'`)
  }

  const overlays = raw.overlays
  if (overlays !== undefined && overlays !== null && !Array.isArray(overlays)) {
    throw new PlanError(`${where}.overlays: expected an array`)
  }

  return {
    id:
      raw.id === undefined || raw.id === null || raw.id === ''
        ? `s${String(index + 1).padStart(2, '0')}`
        : String(raw.id),
    kind,
    source: raw.source === undefined || raw.source === null ? null : String(raw.source),
    color: raw.color === undefined ? '#000000' : String(raw.color),
    generate,
    motion: raw.motion === undefined ? 'none' : enumField(raw.motion, MOTION_TYPES, `${where}.motion`, 'motion'),
    transition: parseTransition(raw.transition, `${where}.transition`),
    fit: raw.fit === undefined ? 'cover' : enumField(raw.fit, FIT_TYPES, `${where}.fit`, 'fit'),
    chromaKey: parseChromaKey(raw.chroma_key ?? raw.chromaKey, `${where}.chroma_key`),
    matte: parseMatte(raw.matte, `${where}.matte`),
    start: raw.start === undefined ? 0 : numberField(raw.start, `${where}.start`, 0),
    speed: raw.speed === undefined ? 1 : numberField(raw.speed, `${where}.speed`, 0.1, 10),
    volume: raw.volume === undefined ? 1 : numberField(raw.volume, `${where}.volume`, 0, 4),
    muted: raw.muted === undefined ? false : Boolean(raw.muted),
    duration: raw.duration === undefined ? 3 : numberField(raw.duration, `${where}.duration`, 0.2, 600),
    overlays: (overlays ?? []).map((overlay, i) => parseOverlay(overlay, `${where}.overlays[${i}]`)),
    note: raw.note === undefined || raw.note === null ? '' : String(raw.note),
    /** Filled by {@link resolvePlanPaths}: the real media file the scene reads. */
    resolved: null,
  }
}

/**
 * Parse the audio block.
 * @param {object|undefined} raw - the decoded `audio` block.
 * @returns {object} the validated audio plan.
 */
function parseAudio(raw) {
  const block = raw ?? {}
  return {
    voiceover: block.voiceover === undefined || block.voiceover === null ? null : String(block.voiceover),
    music: block.music === undefined || block.music === null ? null : String(block.music),
    musicGainDb:
      block.music_gain_db === undefined ? -18 : numberField(block.music_gain_db, 'audio.music_gain_db', -60, 12),
    duck: block.duck === undefined ? true : Boolean(block.duck),
    duckAmount: block.duck_amount === undefined ? 0.18 : numberField(block.duck_amount, 'audio.duck_amount', 0, 1),
    fadeIn: block.fade_in === undefined ? 0 : numberField(block.fade_in, 'audio.fade_in', 0, 60),
    fadeOut: block.fade_out === undefined ? 1.5 : numberField(block.fade_out, 'audio.fade_out', 0, 60),
    loudnessTarget:
      block.loudness_target === undefined ? -14 : numberField(block.loudness_target, 'audio.loudness_target', -40, -5),
    keepSceneAudio: block.keep_scene_audio === undefined ? true : Boolean(block.keep_scene_audio),
  }
}

/**
 * Parse the subtitles block.
 * @param {object|undefined} raw - the decoded `subtitles` block.
 * @returns {object} the validated subtitle plan.
 */
function parseSubtitles(raw) {
  const block = raw ?? {}
  return {
    enabled: block.enabled === undefined ? false : Boolean(block.enabled),
    source: block.source === undefined || block.source === null ? null : String(block.source),
    burn: block.burn === undefined ? true : Boolean(block.burn),
    fontSize: block.font_size === undefined ? 44 : numberField(block.font_size, 'subtitles.font_size', 8, 200),
    marginV: block.margin_v === undefined ? 200 : numberField(block.margin_v, 'subtitles.margin_v', 0, 2000),
    primaryColor: block.primary_color === undefined ? '#FFFFFF' : String(block.primary_color),
    outlineColor: block.outline_color === undefined ? '#000000' : String(block.outline_color),
    outline: block.outline === undefined ? 3 : numberField(block.outline, 'subtitles.outline', 0, 20),
    bold: block.bold === undefined ? false : Boolean(block.bold),
    maxCharsPerLine:
      block.max_chars_per_line === undefined
        ? 18
        : numberField(block.max_chars_per_line, 'subtitles.max_chars_per_line', 4, 80),
  }
}

/**
 * The overlap actually used at the boundary entering `scenes[index]`.
 *
 * Each neighbour contributes at most half its length, so a short scene can never be
 * consumed entirely by its own transition.
 * @param {object[]} scenes - validated scenes.
 * @param {number} index - the incoming scene index, at least 1.
 * @returns {number} seconds of overlap, 0 for a hard cut.
 */
export function effectiveOverlap(scenes, index) {
  const scene = scenes[index]
  if (scene.transition.type === 'none' || scene.transition.duration <= 0) return 0
  return Math.min(scene.transition.duration, scene.duration * 0.5, scenes[index - 1].duration * 0.5)
}

/**
 * Timeline length in seconds, accounting for transition overlap.
 * @param {object[]} scenes - validated scenes.
 * @returns {number} the timeline length.
 */
export function estimatedDuration(scenes) {
  let total = 0
  for (let index = 0; index < scenes.length; index += 1) {
    total += scenes[index].duration
    if (index > 0) total -= effectiveOverlap(scenes, index)
  }
  return Math.max(total, 0)
}

/**
 * The xfade offset for each boundary, or -1 where the cut is hard.
 * @param {object[]} scenes - validated scenes.
 * @returns {number[]} one offset per boundary, length `scenes.length - 1`.
 */
export function transitionOffsets(scenes) {
  const offsets = []
  let running = scenes[0].duration
  for (let index = 1; index < scenes.length; index += 1) {
    const overlap = effectiveOverlap(scenes, index)
    if (overlap <= 0) {
      offsets.push(-1)
    } else {
      offsets.push(running - overlap)
      running -= overlap
    }
    running += scenes[index].duration
  }
  return offsets
}

/**
 * Validate a decoded plan document.
 *
 * @param {object} data - the decoded JSON object.
 * @param {string} baseDir - directory relative `source` paths resolve against.
 * @returns {object} the validated plan.
 * @throws {PlanError} on any structural problem, naming the offending field.
 */
export function parsePlan(data, baseDir) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new PlanError('the top level must be a JSON object')
  }
  const version = data.version === undefined ? PLAN_VERSION : data.version
  if (version !== PLAN_VERSION) {
    throw new PlanError(`Unsupported plan version ${version}; this build understands version ${PLAN_VERSION}`)
  }

  const meta = data.meta ?? {}
  const preset = meta.preset === undefined || meta.preset === null ? '' : String(meta.preset)
  if (preset !== '' && !Object.hasOwn(PRESETS, preset)) {
    throw new PlanError(`meta.preset: unknown preset '${preset}'; expected one of ${Object.keys(PRESETS).join(', ')}`)
  }
  const chosen = preset === '' ? null : PRESETS[preset]
  const width = Math.trunc(numberField(meta.width ?? chosen?.width ?? 1080, 'meta.width', 64, 7680))
  const height = Math.trunc(numberField(meta.height ?? chosen?.height ?? 1920, 'meta.height', 64, 7680))
  const fps = numberField(meta.fps ?? chosen?.fps ?? 30, 'meta.fps', 1, 120)

  const rawScenes = data.scenes
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    throw new PlanError('scenes: the plan must contain at least one scene')
  }
  const scenes = rawScenes.map((raw, index) => parseScene(raw, index))

  const seen = new Set()
  for (const scene of scenes) {
    if (seen.has(scene.id)) throw new PlanError(`scenes: duplicate scene id '${scene.id}'`)
    seen.add(scene.id)
  }

  const quality = meta.quality === undefined || meta.quality === null ? 'high' : String(meta.quality)
  if (!Object.hasOwn(QUALITY, quality)) {
    throw new PlanError(`meta.quality: unknown quality '${quality}'; expected one of ${Object.keys(QUALITY).join(', ')}`)
  }

  return {
    version,
    title: meta.title === undefined || meta.title === null ? '' : String(meta.title),
    preset: preset === '' ? 'custom' : preset,
    width,
    height,
    fps,
    quality,
    audio: parseAudio(data.audio),
    subtitles: parseSubtitles(data.subtitles),
    scenes,
    baseDir,
  }
}

/**
 * Resolve one path against the plan's base directory.
 * @param {string} baseDir - the directory relative paths resolve against.
 * @param {string} value - the recorded path.
 * @returns {string} an absolute path.
 */
function resolvePath(baseDir, value) {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value)
}

/**
 * Resolve every relative path to an absolute one.
 *
 * This does not check existence: `video_plan check` reports missing files as a list,
 * while rendering throws on the first one, and both need the resolved paths first.
 *
 * @param {object} plan - a validated plan, mutated in place.
 * @returns {object} the same plan.
 */
export function resolvePlanPaths(plan) {
  for (const scene of plan.scenes) {
    if (scene.kind === 'color') continue
    if (scene.generate !== null && (scene.source === null || scene.source === '')) {
      scene.resolved = null
      continue
    }
    if (scene.source !== null) scene.resolved = resolvePath(plan.baseDir, scene.source)
    if (scene.generate !== null && scene.generate.reference !== null) {
      scene.generate.reference = resolvePath(plan.baseDir, scene.generate.reference)
    }
    if (scene.generate !== null && scene.generate.lastFrame !== null) {
      scene.generate.lastFrame = resolvePath(plan.baseDir, scene.generate.lastFrame)
    }
  }
  if (plan.audio.voiceover !== null) plan.audio.voiceover = resolvePath(plan.baseDir, plan.audio.voiceover)
  if (plan.audio.music !== null) plan.audio.music = resolvePath(plan.baseDir, plan.audio.music)
  if (plan.subtitles.enabled && plan.subtitles.source !== null && plan.subtitles.source !== 'auto') {
    plan.subtitles.source = resolvePath(plan.baseDir, plan.subtitles.source)
  }
  return plan
}

/**
 * Read and validate a plan from disk.
 *
 * @param {string} path - path to the plan JSON file.
 * @returns {object} the validated plan, with `baseDir` set to the plan's directory.
 * @throws {PlanError} when the file is missing, malformed, or structurally invalid.
 */
export function loadPlan(path) {
  const absolute = resolve(path)
  let text
  try {
    text = readFileSync(absolute, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new PlanError(`Plan file not found: ${absolute}`)
    throw new PlanError(`Cannot read plan file ${absolute}: ${error.message}`)
  }
  // Strip a BOM: PowerShell's default UTF-8 writer emits one, and JSON.parse rejects it.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new PlanError(`${absolute}: invalid JSON: ${error.message}`)
  }
  return parsePlan(data, dirname(absolute))
}

/**
 * Read, validate, and resolve a plan in one call.
 * @param {string} path - path to the plan JSON file.
 * @returns {object} the resolved plan.
 */
export function loadResolvedPlan(path) {
  return resolvePlanPaths(loadPlan(path))
}

/**
 * Verify that every file a plan references actually exists.
 *
 * @param {object} plan - a plan whose paths are already resolved.
 * @param {(path: string) => boolean} [exists] - a file-existence predicate.
 * @returns {string[]} one message per missing file.
 */
export function missingFiles(plan, exists = existsSync) {
  const problems = []
  for (const scene of plan.scenes) {
    if (scene.kind === 'color') continue
    if (scene.resolved !== null && !exists(scene.resolved)) {
      problems.push(`scenes[${scene.id}].source: file not found: ${scene.resolved}`)
    }
    if (scene.generate !== null && scene.generate.reference !== null && !exists(scene.generate.reference)) {
      problems.push(`scenes[${scene.id}].generate.reference not found: ${scene.generate.reference}`)
    }
    if (scene.generate !== null && scene.generate.lastFrame !== null && !exists(scene.generate.lastFrame)) {
      problems.push(`scenes[${scene.id}].generate.last_frame not found: ${scene.generate.lastFrame}`)
    }
  }
  if (plan.audio.voiceover !== null && !exists(plan.audio.voiceover)) {
    problems.push(`audio.voiceover: file not found: ${plan.audio.voiceover}`)
  }
  if (plan.audio.music !== null && !exists(plan.audio.music)) {
    problems.push(`audio.music: file not found: ${plan.audio.music}`)
  }
  if (
    plan.subtitles.enabled &&
    plan.subtitles.source !== null &&
    plan.subtitles.source !== 'auto' &&
    !exists(plan.subtitles.source)
  ) {
    problems.push(`subtitles.source: file not found: ${plan.subtitles.source}`)
  }
  return problems
}

/**
 * The plan.json field reference, read once from the packaged markdown.
 *
 * It lives in a markdown file rather than a template literal so that editing the
 * documentation cannot corrupt the module, and so the reference stays readable on
 * its own.
 *
 * @returns {string} the field reference document.
 */
export function fieldReference() {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'PLAN-FIELDS.md')
  return readFileSync(path, 'utf8')
}
