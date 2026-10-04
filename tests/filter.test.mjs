/**
 * Offline checks for filter-graph construction.
 *
 * These assert the exact strings handed to ffmpeg. A wrong filter string is the
 * hardest failure to diagnose from a render log, so it is pinned here rather than
 * discovered mid-render. See docs/插件设计规格.md §12.1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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
} from '../src/core/filter.mjs'

test('toFfmpegColor converts #RRGGBB and expands #RGB', () => {
  assert.equal(toFfmpegColor('#FFFFFF'), '0xFFFFFF')
  assert.equal(toFfmpegColor('#000000'), '0x000000')
  assert.equal(toFfmpegColor('#0a0b0c'), '0x0A0B0C')
  assert.equal(toFfmpegColor('#abc'), '0xAABBCC')
  assert.equal(toFfmpegColor('abc'), '0xAABBCC')
})

test('toFfmpegColor rejects anything that is not a hex colour', () => {
  assert.throws(() => toFfmpegColor('red'), FilterError)
  assert.throws(() => toFfmpegColor('#12345'), FilterError)
  assert.throws(() => toFfmpegColor(''), FilterError)
})

test('toAssColor emits BGR order, not RGB', () => {
  // ASS stores &HAABBGGRR, so pure red #FF0000 must end in 0000FF.
  assert.equal(toAssColor('#FF0000'), '&H000000FF')
  assert.equal(toAssColor('#0000FF'), '&H00FF0000')
  assert.equal(toAssColor('#FFFFFF'), '&H00FFFFFF')
  assert.equal(toAssColor('#000000'), '&H00000000')
  assert.throws(() => toAssColor('#FFF'), FilterError)
})

test('atempoChain is empty at 1x and splits beyond the per-instance range', () => {
  assert.equal(atempoChain(1), '')
  assert.equal(atempoChain(1.0000000001), '')
  assert.equal(atempoChain(1.5), 'atempo=1.500000')
  // 4x exceeds the ~2.0 ceiling of one instance, so it is split.
  assert.equal(atempoChain(4), 'atempo=2.0,atempo=2.000000')
  // 0.25x is below the ~0.5 floor, so it is split downwards.
  assert.equal(atempoChain(0.25), 'atempo=0.5,atempo=0.500000')
  // The product of the chain must equal the requested speed.
  const parts = atempoChain(3).split(',').map((part) => Number(part.split('=')[1]))
  assert.ok(Math.abs(parts.reduce((a, b) => a * b, 1) - 3) < 1e-6)
})

test('fitFilters produces the documented fragment per fit', () => {
  assert.equal(
    fitFilters('cover', 1080, 1920),
    'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
  )
  assert.equal(
    fitFilters('contain', 1080, 1920),
    'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black',
  )
  const blurred = fitFilters('blur-pad', 1080, 1920)
  assert.ok(blurred.includes('gblur=sigma=28'))
  assert.ok(blurred.includes('eq=brightness=-0.10'))
  assert.ok(blurred.includes('overlay=(W-w)/2:(H-h)/2'))
  // A superscript must reach every label in the split, or two blur-pad scenes in
  // one graph would collide.
  const tagged = fitFilters('blur-pad', 1080, 1920, 's01')
  for (const label of ['bgf_s01', 'fgf_s01', 'bgb_s01', 'fgs_s01']) {
    assert.ok(tagged.includes(label), `missing split label ${label}`)
  }
  assert.throws(() => fitFilters('stretch', 1, 1), FilterError)
})

test('motionFilters returns nothing for none and supersamples otherwise', () => {
  assert.equal(motionFilters('none', 100, 1080, 1920, 30), '')
  assert.equal(motionFilters('zoom-in', 1, 1080, 1920, 30), '', 'one frame cannot move')

  const zoomIn = motionFilters('zoom-in', 105, 1080, 1920, 30)
  assert.ok(zoomIn.startsWith(`scale=${1080 * MOTION_SUPERSAMPLE}:${1920 * MOTION_SUPERSAMPLE}`))
  assert.ok(zoomIn.includes('zoompan=z=\'1+0.18*(on/104)\''))
  assert.ok(zoomIn.includes('d=1'))
  assert.ok(zoomIn.includes('s=1080x1920'))
  assert.ok(zoomIn.includes('fps=30.000000'))

  assert.ok(motionFilters('zoom-out', 105, 1080, 1920, 30).includes("1.18-0.18*(on/104)"))
  assert.ok(motionFilters('pan-right', 105, 1080, 1920, 30).includes('x=\'(iw-iw/zoom)*(on/104)\''))
  assert.ok(motionFilters('pan-left', 105, 1080, 1920, 30).includes('x=\'(iw-iw/zoom)*(1-(on/104))\''))
  const ken = motionFilters('kenburns', 105, 1080, 1920, 30)
  assert.ok(ken.includes('1.05+0.15*(on/104)'))
  assert.throws(() => motionFilters('spin', 100, 1080, 1920, 30), FilterError)
})

test('anchorExpressions covers all nine anchors and rejects others', () => {
  assert.deepEqual(anchorExpressions('bottom-center', 80), { x: '(w-text_w)/2', y: 'h-text_h-80' })
  assert.deepEqual(anchorExpressions('top-left', 10), { x: '10', y: '10' })
  assert.deepEqual(anchorExpressions('center', 5), { x: '(w-text_w)/2', y: '(h-text_h)/2' })
  assert.deepEqual(anchorExpressions('center-right', 5), { x: 'w-text_w-5', y: '(h-text_h)/2' })
  assert.throws(() => anchorExpressions('middle', 10), FilterError)
})

test('overlay text is staged to a file, never interpolated into the graph', () => {
  const overlay = {
    text: '开场标题',
    anchor: 'bottom-center',
    fontSize: 48,
    color: '#FFFFFF',
    box: true,
    margin: 80,
    start: 0,
    end: null,
  }
  const fragment = overlayFilter(overlay, {
    sceneDuration: 3.5,
    canvasWidth: 1080,
    fontFile: 'fonts/cjk.ttc',
    textFile: 'ov_s01_0.txt',
  })
  assert.ok(fragment.includes("textfile='ov_s01_0.txt'"))
  // The literal text must NOT appear in the graph: escaping it is the failure mode
  // this design removes.
  assert.ok(!fragment.includes('开场标题'), 'overlay text must not be inlined')
  assert.ok(fragment.includes("fontfile='fonts/cjk.ttc'"))
  assert.ok(fragment.includes('fontcolor=0xFFFFFF'))
  assert.ok(fragment.includes('fontsize=48'))
  assert.ok(fragment.includes("enable='between(t\\,0.000\\,3.500)'"), 'end=null runs to the scene end')
  assert.ok(fragment.includes('box=1'))

  // Font size and margin scale with the canvas, so a 4K preset keeps proportions.
  const wide = overlayFilter(overlay, {
    sceneDuration: 3,
    canvasWidth: 3840,
    fontFile: null,
    textFile: 'ov.txt',
  })
  assert.ok(wide.includes('fontsize=171'))
  assert.ok(!wide.includes('fontfile='))
  assert.ok(wide.includes("enable='between(t\\,0.000\\,3.000)'"))

  assert.throws(() => overlayFilter(overlay, { sceneDuration: 3, canvasWidth: 1080, fontFile: null }), FilterError)
})

test('overlayFilter honours an explicit end time', () => {
  const fragment = overlayFilter(
    { text: 'x', anchor: 'top-left', fontSize: 40, color: '#FF0000', box: false, margin: 20, start: 0.5, end: 2.25 },
    { sceneDuration: 5, canvasWidth: 1080, fontFile: null, textFile: 'ov.txt' },
  )
  assert.ok(fragment.includes("enable='between(t\\,0.500\\,2.250)'"))
  assert.ok(!fragment.includes('box=1'))
  assert.ok(fragment.includes('fontcolor=0xFF0000'))
})

test('applyOverlays is a no-op without overlays and stages one file per overlay', () => {
  assert.equal(applyOverlays('scale=1:1', [], { sceneDuration: 1, canvasWidth: 1080, fontFile: null }), 'scale=1:1')
  const staged = []
  const context = {
    sceneDuration: 3,
    canvasWidth: 1080,
    fontFile: null,
    textFileFor: (_overlay, index) => {
      const name = `ov_${index}.txt`
      staged.push(name)
      return name
    },
  }
  const chained = applyOverlays(
    'scale=1:1',
    [
      { text: 'a', anchor: 'top-left', fontSize: 40, color: '#FFFFFF', box: false, margin: 10, start: 0, end: null },
      { text: 'b', anchor: 'bottom-right', fontSize: 40, color: '#FFFFFF', box: false, margin: 10, start: 0, end: null },
    ],
    context,
  )
  assert.equal(chained.split('drawtext=').length - 1, 2, 'both overlays must be drawn')
  assert.deepEqual(staged, ['ov_0.txt', 'ov_1.txt'], 'each overlay gets its own staged file')
  assert.ok(chained.startsWith('scale=1:1,drawtext='))
})

test('subtitleStyle emits ASS colours in the right order', () => {
  const style = subtitleStyle({
    fontSize: 44,
    marginV: 200,
    outline: 3,
    primaryColor: '#FFFFFF',
    outlineColor: '#000000',
  })
  assert.ok(style.includes('PrimaryColour=&H00FFFFFF'))
  assert.ok(style.includes('OutlineColour=&H00000000'))
  assert.ok(style.includes('FontSize=44'))
  assert.ok(style.includes('MarginV=200'))
})

test('subtitleStyle converts canvas pixels into ASS script units', () => {
  // The SRT is converted at the default 384x288 script resolution, so values measured in
  // canvas pixels have to be divided down or all of them land 3.75x too large. 78 px is what
  // `video_narrate {action:"layout"}` advises for a 1920x1080 canvas, and it has to come out
  // as 21 script units; writing 78 through unchanged is what rendered 250 px glyphs.
  const style = subtitleStyle(
    { fontSize: 78, marginV: 112, outline: 3, primaryColor: '#FFFFFF', outlineColor: '#000000' },
    { width: 1920, height: 1080 },
  )
  assert.ok(style.includes('FontSize=21'), style)
  assert.ok(style.includes('MarginV=30'), style)
  assert.ok(style.includes('Outline=1'), style)
})

test('subtitleStyle leaves a canvas that already matches the script height alone', () => {
  const style = subtitleStyle(
    { fontSize: 44, marginV: 200, outline: 3, primaryColor: '#FFFFFF', outlineColor: '#000000' },
    { width: 512, height: 288 },
  )
  assert.ok(style.includes('FontSize=44'))
  assert.ok(style.includes('MarginV=200'))
})

test('subtitleStyle never rounds a visible outline away to nothing', () => {
  // One script unit is 3.75 canvas pixels at 1080p, so the floor of 1 still leaves a
  // visible edge; rounding 0.8 down to 0 would silently drop the outline entirely.
  const style = subtitleStyle(
    { fontSize: 44, marginV: 200, outline: 1, primaryColor: '#FFFFFF', outlineColor: '#000000' },
    { width: 1920, height: 1080 },
  )
  assert.ok(style.includes('Outline=1'), style)
})
