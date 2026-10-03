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
 * Build the ASS force_style value for burned-in subtitles.
 * @param {object} subtitles - the validated subtitle plan.
 * @returns {string} the style string.
 */
export function subtitleStyle(subtitles) {
  return (
    `FontName=Microsoft YaHei,FontSize=${subtitles.fontSize},` +
    `MarginV=${subtitles.marginV},Outline=${subtitles.outline},` +
    `OutlineColour=${toAssColor(subtitles.outlineColor)},` +
    `PrimaryColour=${toAssColor(subtitles.primaryColor)},` +
    'BorderStyle=1,Shadow=0'
  )
}
