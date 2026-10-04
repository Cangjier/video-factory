/**
 * Filter-graph construction: pure computation, no I/O.
 *
 * Every function here maps declared intent onto the exact ffmpeg filter syntax the
 * pipeline needs. They are pure on purpose: the strings they return are the part of
 * a render that is hardest to debug from a failure message, so they are computed and
 * asserted offline before ffmpeg ever sees them.
 *
 * Two Windows facts drive the shapes below. The bundled ffmpeg has no fontconfig, so
 * drawing text needs an explicit font file. And a Windows drive letter contains a
 * colon, which the filter-graph parser reads as an option separator — which is why
 * overlay text travels through `textfile=` and staged paths are referenced relative
 * to the working directory.
 *
 * @module video-factory/core/filter
 */
import { ANCHORS } from './plan.mjs'

/** The nine legal overlay anchors, re-exported so callers need one import. */
export { ANCHORS }

/** Multiplier applied to the canvas before `zoompan`, to suppress sub-pixel jitter. */
export const MOTION_SUPERSAMPLE = 4

/** Raised when a filter cannot be constructed from the given intent. */
export class FilterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FilterError'
  }
}

/**
 * Build the chroma-key fragment that makes one colour transparent.
 *
 * This is the zero-cost half of background replacement: a green screen or any flat-colour
 * backdrop needs no model at all, and `colorkey` runs at essentially the speed of the decode.
 * The learned-matting route (see `video_analyze {action:"matte"}`) is only needed when the
 * backdrop is not a flat colour.
 *
 * `colorkey` rather than `chromakey`: both exist in this build, but `chromakey` measures in YUV
 * and `colorkey` in RGB, and a plan specifies its key in RGB hex. Matching the space the caller
 * thinks in avoids a conversion step whose error would be invisible but real.
 *
 * **The defaults are conservative on purpose.** The similarity is a distance in RGB, so its
 * useful value depends on the footage — lighting, spill, and compression all move it.
 * Calibration against a synthetic plate showed a wide range of values that separate cleanly,
 * which means a synthetic plate cannot pick the right one; only real footage can. So the default
 * errs toward keeping too much rather than eating the subject, and
 * {@link chromaKeyValues} reports the resolved number so it can be tuned against a real frame.
 *
 * `despill` is on by default because green light bounces onto the subject and leaves a fringe
 * that survives the key; removing the key without removing the spill looks like a bad cutout
 * even when the alpha is perfect.
 *
 * @param {object} key - `{ color, similarity, blend, spill }`.
 * @returns {string} the filter fragment, or `''` when no key is configured.
 * @throws {FilterError} when a value is out of range or the colour is malformed.
 */
export function chromaKeyFilter(key) {
  if (key === undefined || key === null) return ''
  const values = chromaKeyValues(key)

  const parts = [`colorkey=${values.color}:${values.similarity}:${values.blend}`]
  // `despill` needs to know which channel is the screen, which is a property of the key colour
  // rather than of the footage: green screens spill green, blue screens spill blue.
  if (values.despill) parts.push(`despill=type=${values.spillType}`)
  return parts.join(',')
}

/**
 * Resolve and validate a chroma-key block into the numbers the filter will actually use.
 *
 * Split out from {@link chromaKeyFilter} so a caller — or a test — can see the resolved values
 * without parsing the filter string, and so the tool can report exactly what it applied.
 *
 * @param {object} key - `{ color, similarity, blend, spill }`.
 * @returns {{color: string, inputColor: string, similarity: number, blend: number, despill: boolean, spillType: string}} the resolved settings.
 * @throws {FilterError} when a value is out of range.
 */
export function chromaKeyValues(key) {
  const inputColor = key.color === undefined || key.color === null ? '#00B140' : String(key.color)
  const color = toFfmpegColor(inputColor)
  const similarity = rangeField(key.similarity, 'chromaKey.similarity', 0.01, 1, 0.3)
  const blend = rangeField(key.blend, 'chromaKey.blend', 0, 1, 0.1)
  if (similarity + blend > 1) {
    throw new FilterError(
      `chromaKey: similarity (${similarity}) + blend (${blend}) must not exceed 1; ` +
        'together they are the full distance range, so a sum above 1 has no meaning',
    )
  }
  return {
    color,
    inputColor,
    similarity,
    blend,
    // `spill` is accepted as an alias for `despill` so the plan field reads naturally either way.
    despill: key.despill === undefined ? key.spill === undefined ? true : Boolean(key.spill) : Boolean(key.despill),
    spillType: spillTypeOf(inputColor),
  }
}

/**
 * Which channel `despill` should pull down, inferred from the key colour.
 *
 * A green screen spills green and a blue screen spills blue. Inferring it from the key means a
 * caller cannot accidentally leave blue spill on a green key, which is the failure that makes a
 * cutout look wrong in a way that is hard to name.
 *
 * @param {string} color - the key colour, `#RRGGBB` or `#RGB`.
 * @returns {'green'|'blue'} the channel to despill.
 */
function spillTypeOf(color) {
  const text = String(color).trim().replace(/^#/, '')
  const expanded = text.length === 3 ? text.split('').map((c) => c + c).join('') : text
  const red = parseInt(expanded.slice(0, 2), 16)
  const green = parseInt(expanded.slice(2, 4), 16)
  const blue = parseInt(expanded.slice(4, 6), 16)
  // Whichever of green/blue dominates is the screen; green wins a tie, which only happens on a
  // colour that is neither, and there green is the more common intent.
  return blue > green ? 'blue' : 'green'
}

/**
 * Build the two-input fragment that keys a source and lays it over a solid background.
 *
 * A key on its own produces transparency, and a scene that ends in `format=yuv420p` discards it —
 * so `colorkey` by itself changes nothing visible. Replacement only happens when the keyed source
 * is composited onto something, which is why the background is part of this fragment rather than
 * a separate step.
 *
 * The order is load-bearing: key into RGBA **first**, then `overlay`. Compositing an opaque
 * frame and keying afterwards has nothing left to key against the background.
 *
 * The background is generated with `lavfi` here rather than supplied as a second input, which
 * keeps the scene a single-input graph. An image or video background needs a real second input
 * and therefore a change to how `sceneArguments` builds its argument list; that is deliberately
 * not done here so this half can land without touching the render contract.
 *
 * @param {object} key - `{ color, similarity, blend, spill, background }`.
 * @param {number} width - canvas width.
 * @param {number} height - canvas height.
 * @param {number} fps - output frame rate.
 * @param {number} duration - the scene's length in seconds.
 * @returns {{input: string[], video: string, label: string}} the background input args and the
 *   filter fragment, or null when no background was requested.
 * @throws {FilterError} when the background is not a colour.
 */
export function chromaKeyComposite(key, width, height, fps, duration) {
  if (key === undefined || key === null) return null
  const background = key.background
  if (background === undefined || background === null || background === '') return null
  if (typeof background !== 'string') {
    throw new FilterError(
      `chromaKey.background: expected a hex colour for now, got ${typeof background}. ` +
        'An image or video background needs a second input and is not supported yet.',
    )
  }
  if (background.includes('/') || background.includes('\\') || background.includes('.')) {
    throw new FilterError(
      `chromaKey.background: '${background}' looks like a file path, but only a hex colour is ` +
        'supported. An image or video background needs a second input and is not supported yet.',
    )
  }

  const keyFilter = chromaKeyFilter(key)
  if (keyFilter === '') throw new FilterError('chromaKeyComposite needs a key, but none was configured')
  const color = toFfmpegColor(background)
  const seconds = Number(duration)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new FilterError(`chromaKeyComposite needs a positive scene duration, got ${JSON.stringify(duration)}`)
  }

  return {
    // ffmpeg wants an input's options before its `-i`, so these are prefixed rather than
    // appended: `['-f','lavfi','-i',…]` is a complete input specification, not trailing flags.
    //
    // `-t` is not optional. A `lavfi` source is infinite by default, and an infinite second input
    // to `overlay` makes the graph emit frames forever; the picture was then capped by the
    // output `-t` but the audio ran out, and the render died inside the AAC encoder with
    // "Error submitting audio frame to the encoder" — a message that says nothing about the
    // real cause. A finite colour source is what keeps the graph's ends together.
    input: ['-f', 'lavfi', '-t', seconds.toFixed(3), '-i', `color=c=${color}:s=${width}x${height}:r=${fps.toFixed(6)}`],
    // The keyed frame must reach `overlay` with its alpha intact, hence `format=rgba` after the
    // key and no pixel-format conversion before the overlay.
    video: `[0:v]${keyFilter},format=rgba[ckfg];[1:v]format=rgba[ckbg];[ckbg][ckfg]overlay=0:0:format=auto`,
    label: 'ck',
  }
}
/**
 * Read an optional number within a range, falling back to a default.
 * @param {*} value - the candidate.
 * @param {string} where - field name for the error message.
 * @param {number} minimum - inclusive lower bound.
 * @param {number} maximum - inclusive upper bound.
 * @param {number} fallback - used when the value is absent.
 * @returns {number} the validated number.
 * @throws {FilterError} when the value is present but unusable.
 */
function rangeField(value, where, minimum, maximum, fallback) {
  if (value === undefined || value === null) return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new FilterError(`${where}: expected a number between ${minimum} and ${maximum}, got ${JSON.stringify(value)}`)
  }
  return number
}

/**
 * Convert `#RRGGBB` into the `0xRRGGBB` form ffmpeg accepts.
 * @param {string} color - a hex colour, with or without the leading `#`.
 * @returns {string} the ffmpeg colour literal.
 * @throws {FilterError} when the value is not a hex colour.
 */
export function toFfmpegColor(color) {
  let text = String(color).trim().replace(/^#/, '')
  if (text.length === 3) text = text.split('').map((character) => character + character).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) {
    throw new FilterError(`Invalid color '${color}'; expected #RRGGBB or #RGB`)
  }
  return `0x${text.toUpperCase()}`
}

/**
 * Convert `#RRGGBB` into ASS's `&HAABBGGRR` ordering.
 *
 * ASS stores colours as BGR, not RGB, which is the classic source of swapped
 * red and blue subtitles.
 * @param {string} color - a hex colour, with or without the leading `#`.
 * @returns {string} the ASS colour literal.
 * @throws {FilterError} when the value is not a hex colour.
 */
export function toAssColor(color) {
  const text = String(color).trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) {
    throw new FilterError(`Invalid color '${color}'; expected #RRGGBB`)
  }
  const red = text.slice(0, 2)
  const green = text.slice(2, 4)
  const blue = text.slice(4, 6)
  return `&H00${blue}${green}${red}`.toUpperCase()
}

/**
 * Build the atempo chain for a playback speed.
 *
 * A single `atempo` instance only accepts roughly 0.5–2.0, so larger or smaller
 * factors are split across instances whose product equals the requested speed.
 * @param {number} speed - playback speed multiplier; 1 yields an empty chain.
 * @returns {string} a comma-joined filter fragment, or `''` when no change is needed.
 */
export function atempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-9) return ''
  const parts = []
  let remaining = speed
  while (remaining > 2) {
    parts.push('atempo=2.0')
    remaining /= 2
  }
  while (remaining < 0.5) {
    parts.push('atempo=0.5')
    remaining /= 0.5
  }
  parts.push(`atempo=${remaining.toFixed(6)}`)
  return parts.join(',')
}

/**
 * Build the scale/crop/pad fragment that maps any source onto the canvas.
 *
 * @param {string} fit - `cover`, `contain`, or `blur-pad`.
 * @param {number} width - canvas width.
 * @param {number} height - canvas height.
 * @param {string} [superscript] - label suffix for the blur-pad split, needed when
 *   several blur-pad scenes share one filter graph.
 * @returns {string} the filter fragment.
 * @throws {FilterError} on an unknown fit.
 */
export function fitFilters(fit, width, height, superscript = '') {
  if (fit === 'contain') {
    return (
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    )
  }
  if (fit === 'blur-pad') {
    const tag = superscript === '' ? '' : `_${superscript}`
    return (
      `split=2[bgf${tag}][fgf${tag}];` +
      `[bgf${tag}]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.10[bgb${tag}];` +
      `[fgf${tag}]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs${tag}];` +
      `[bgb${tag}][fgs${tag}]overlay=(W-w)/2:(H-h)/2`
    )
  }
  if (fit === 'cover') {
    return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
  }
  throw new FilterError(`Unknown fit '${fit}'; expected cover, contain, or blur-pad`)
}

/**
 * Build the supersample-plus-`zoompan` fragment for one still image.
 *
 * The still is upscaled first because `zoompan` crops on an integer pixel grid;
 * zooming a canvas-sized image produces visible stepping.
 *
 * @param {string} motion - a motion type name.
 * @param {number} frames - output frame count for the scene.
 * @param {number} width - canvas width.
 * @param {number} height - canvas height.
 * @param {number} fps - output frame rate.
 * @returns {string} the filter fragment, or `''` for `none`.
 * @throws {FilterError} on an unknown motion.
 */
export function motionFilters(motion, frames, width, height, fps) {
  if (motion === 'none' || frames <= 1) return ''
  const span = Math.max(frames - 1, 1)
  const progress = `(on/${span})`
  const sw = width * MOTION_SUPERSAMPLE
  const sh = height * MOTION_SUPERSAMPLE
  const centerX = '(iw-iw/zoom)/2'
  const centerY = '(ih-ih/zoom)/2'

  let zoom
  let x
  let y
  if (motion === 'zoom-in') {
    zoom = `1+0.18*${progress}`
    x = centerX
    y = centerY
  } else if (motion === 'zoom-out') {
    zoom = `1.18-0.18*${progress}`
    x = centerX
    y = centerY
  } else if (motion === 'pan-right') {
    zoom = '1.15'
    x = `(iw-iw/zoom)*${progress}`
    y = centerY
  } else if (motion === 'pan-left') {
    zoom = '1.15'
    x = `(iw-iw/zoom)*(1-${progress})`
    y = centerY
  } else if (motion === 'kenburns') {
    zoom = `1.05+0.15*${progress}`
    x = `(iw-iw/zoom)*(0.5+0.35*${progress})`
    y = `(ih-ih/zoom)*(0.5-0.30*${progress})`
  } else {
    throw new FilterError(`Unknown motion '${motion}'`)
  }

  const pre = `scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh}`
  // `d=1` pairs with a looped input whose length is already the scene duration, so
  // every input frame yields exactly one output frame and `on` counts scene frames.
  const zoompan = `zoompan=z='${zoom}':x='${x}':y='${y}':d=1:s=${width}x${height}:fps=${fps.toFixed(6)}`
  return `${pre},${zoompan}`
}

/**
 * Resolve one overlay anchor into x/y expressions.
 *
 * The anchor is checked against the explicit list rather than parsed optimistically:
 * a bare `center` is legal but a bare `middle` is not, and only a whitelist tells
 * those apart.
 *
 * @param {string} anchor - one of the nine anchors.
 * @param {number} margin - distance in pixels from the anchored edges.
 * @returns {{x: string, y: string}} the expressions.
 * @throws {FilterError} when the anchor is not one of the nine.
 */
export function anchorExpressions(anchor, margin) {
  if (!ANCHORS.includes(anchor)) {
    throw new FilterError(`Unknown overlay anchor '${anchor}'; expected one of ${ANCHORS.join(', ')}`)
  }
  const [vertical, horizontal] = anchor === 'center' ? ['center', 'center'] : anchor.split('-')
  const xs = { left: `${margin}`, center: '(w-text_w)/2', right: `w-text_w-${margin}` }
  const ys = { top: `${margin}`, center: '(h-text_h)/2', bottom: `h-text_h-${margin}` }
  return { x: xs[horizontal], y: ys[vertical] }
}

/**
 * Build the `drawtext` fragment for one overlay.
 *
 * The text is read from a file staged beside the render (`textfile=`), never
 * interpolated into the graph. Passing it inline would mean escaping backslashes,
 * quotes, colons, and percent signs for two nested parsers, and a single miss
 * mis-renders or silently drops the label. Staging also keeps the drive-letter colon
 * out of the graph entirely.
 *
 * @param {object} overlay - a validated overlay.
 * @param {object} context - drawing context.
 * @param {number} context.sceneDuration - the scene's length, used when `end` is null.
 * @param {number} context.canvasWidth - canvas width, used to scale the font size.
 * @param {string} context.textFile - staged text filename, relative to the working directory.
 * @param {string|null} context.fontFile - font path relative to the working directory.
 * @returns {string} the `drawtext` fragment.
 */
export function overlayFilter(overlay, context) {
  if (typeof context.textFile !== 'string' || context.textFile === '') {
    throw new FilterError('overlayFilter needs context.textFile: overlay text is staged to a file, never inlined')
  }
  const scale = context.canvasWidth / 1080
  const fontSize = Math.max(12, Math.round(overlay.fontSize * scale))
  const margin = Math.round(overlay.margin * scale)
  const { x, y } = anchorExpressions(overlay.anchor, margin)
  const end = overlay.end === null ? context.sceneDuration : overlay.end
  const enable = `between(t\\,${overlay.start.toFixed(3)}\\,${end.toFixed(3)})`
  const box = overlay.box ? `:box=1:boxcolor=black@0.45:boxborderw=${Math.max(8, Math.floor(fontSize / 3))}` : ''
  const font = context.fontFile === null || context.fontFile === undefined ? '' : `:fontfile='${context.fontFile}'`
  const color = toFfmpegColor(overlay.color)
  return (
    `drawtext=textfile='${context.textFile}'${font}:fontcolor=${color}:fontsize=${fontSize}` +
    `:x=${x}:y=${y}${box}:enable='${enable}'`
  )
}

/**
 * Append the scene's overlays to a video filter chain.
 * @param {string} fragment - the current chain.
 * @param {object[]} overlays - validated overlays.
 * @param {object} context - drawing context, see {@link overlayFilter} plus a
 *   `textFileFor(overlay, index)` function that stages each overlay's text.
 * @returns {string} the extended chain.
 */
export function applyOverlays(fragment, overlays, context) {
  if (overlays === undefined || overlays.length === 0) return fragment
  const parts = [fragment]
  for (const [index, overlay] of overlays.entries()) {
    parts.push(overlayFilter(overlay, { ...context, textFile: context.textFileFor(overlay, index) }))
  }
  return parts.join(',')
}

/**
 * The reference resolution libass lays an ASS script out against when the script does not
 * declare its own. ffmpeg converts an SRT with exactly this default, which is the whole
 * reason {@link subtitleStyle} has to convert anything.
 */
const ASS_SCRIPT_HEIGHT = 288

/**
 * Build the ASS force_style value for burned-in subtitles.
 *
 * `font_size`, `margin_v` and `outline` are canvas pixels, but an ASS `FontSize`, `MarginV`
 * and `Outline` are in *script* units, and the SRT this rides on is converted at the default
 * 384x288 script resolution. Passing a canvas value through unchanged therefore multiplies it
 * by height/288 — 3.75x on a 1080p frame. Measured: `video_narrate {action:"layout"}` advises
 * 78 px for a 1920x1080 canvas, and writing that straight through rendered ~250 px glyphs
 * floating in the middle of the picture, because 78 script units is 292 canvas pixels.
 *
 * @param {object} subtitles - the validated subtitle plan, in canvas pixels.
 * @param {{height?: number}} [canvas] - the output canvas, used to convert to script units.
 * @returns {string} the style string.
 */
export function subtitleStyle(subtitles, canvas) {
  const height = Number(canvas?.height) > 0 ? Number(canvas.height) : ASS_SCRIPT_HEIGHT
  const toScript = ASS_SCRIPT_HEIGHT / height
  const fontSize = Math.max(1, Math.round(subtitles.fontSize * toScript))
  const marginV = Math.max(0, Math.round(subtitles.marginV * toScript))
  const outline = Math.max(1, Math.round(subtitles.outline * toScript))
  return (
    `FontName=Microsoft YaHei,FontSize=${fontSize},` +
    `MarginV=${marginV},Outline=${outline},` +
    `OutlineColour=${toAssColor(subtitles.outlineColor)},` +
    `PrimaryColour=${toAssColor(subtitles.primaryColor)},` +
    'BorderStyle=1,Shadow=0'
  )
}
