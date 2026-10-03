/**
 * Render checks that need real ffmpeg.
 *
 * These verify the parts a pure-function test cannot: that the filter graph ffmpeg is
 * handed actually runs, and that the optional decorations really reach the picture. A
 * scene that renders "successfully" while silently dropping its text is exactly the
 * failure this file exists to catch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePlan } from '../src/core/plan.mjs'
import { clipPath, renderScene } from '../src/core/scene.mjs'
import { probe } from '../src/core/probe.mjs'
import { run } from '../src/core/ffmpeg.mjs'

/**
 * The spread between the darkest and lightest pixel of a frame.
 *
 * A solid colour has a spread of 0, so any drawing on top of it is unmistakable. The
 * extremes are found by iteration rather than `Math.max(...pixels)`, which overflows the
 * call stack on a full frame.
 * @param {Buffer} pixels - raw greyscale bytes.
 * @returns {number} max minus min, or 0 for an empty buffer.
 */
function pixelSpread(pixels) {
  if (pixels.length === 0) return 0
  let minimum = 255
  let maximum = 0
  for (const value of pixels) {
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  return maximum - minimum
}

/**
 * Decode one frame of a clip to raw greyscale bytes.
 * @param {string} clip - the clip to sample.
 * @param {number} seconds - where to sample.
 * @returns {Promise<Buffer>} the pixel bytes.
 */
async function framePixels(clip, seconds = 0) {
  const result = await run({
    tool: 'ffmpeg',
    args: ['-ss', String(seconds), '-i', clip, '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', '-'],
    stdoutEncoding: 'binary',
  })
  return Buffer.from(result.stdout, 'binary')
}

/** Render one scene in a scratch directory and return the probed clip. */
async function renderOne(sceneDoc, index = 0) {
  const plan = parsePlan(
    { version: 1, meta: { preset: 'preview' }, scenes: [sceneDoc] },
    mkdtempSync(join(tmpdir(), 'vf-render-')),
  )
  const workDir = mkdtempSync(join(tmpdir(), 'vf-work-'))
  const result = await renderScene(plan.scenes[index], plan, index, { workDir, force: true })
  return { clip: result.path, plan, workDir, info: await probe(result.path) }
}

test('a colour scene renders with the requested canvas and an audio track', async () => {
  const { clip, info } = await renderOne({ kind: 'color', color: '#204060', duration: 2 })
  assert.ok(existsSync(clip))
  assert.equal(info.kind, 'video')
  assert.equal(info.width, 640, 'preview preset width')
  assert.equal(info.height, 360)
  assert.equal(info.hasAudio, true, 'every normalized clip carries an audio track')
  assert.equal(info.pixFmt, 'yuv420p')
  assert.ok(Math.abs(info.duration - 2) < 0.15, `expected ~2s, got ${info.duration}`)
})

test('a still image renders with motion and lands at exactly the scene duration', async () => {
  const source = 'examples/demo/material'
  const { readdirSync } = await import('node:fs')
  const still = join(source, readdirSync(source).find((name) => name.endsWith('.jpg')))

  const { info } = await renderOne({ kind: 'image', source: still, duration: 1.5, motion: 'kenburns' })
  assert.equal(info.width, 640)
  assert.equal(info.height, 360)
  assert.ok(Math.abs(info.duration - 1.5) < 0.1, `expected ~1.5s, got ${info.duration}`)
  assert.equal(info.fps > 0, true)
})

test('overlay text actually reaches the picture on a colour scene', async () => {
  // The comparison is the assertion: a bare colour frame is perfectly uniform, so any
  // spread in pixel values proves something was drawn on top of it. This is the check
  // that caught overlays being silently skipped on `kind: "color"`.
  const bare = await renderOne({ kind: 'color', color: '#101820', duration: 1 })
  const titled = await renderOne({
    kind: 'color',
    color: '#101820',
    duration: 1,
    overlays: [{ text: '中文字幕覆层', anchor: 'center', font_size: 64, start: 0 }],
  })

  assert.equal(pixelSpread(await framePixels(bare.clip)), 0, 'a solid colour frame must be perfectly uniform')
  assert.ok(
    pixelSpread(await framePixels(titled.clip)) > 100,
    'a titled frame must contain both light glyphs and dark background',
  )
})

test('an overlay that starts later is absent from the first frame', async () => {
  const { clip } = await renderOne({
    kind: 'color',
    color: '#101820',
    duration: 1,
    overlays: [{ text: '稍后出现', anchor: 'center', font_size: 64, start: 0.6 }],
  })

  assert.equal(pixelSpread(await framePixels(clip, 0.1)), 0, 'before the start time the frame must still be bare')
  assert.ok(pixelSpread(await framePixels(clip, 0.8)) > 100, 'after the start time the text must be visible')
})

test('a clip is reused on a second render unless force is set', async () => {
  const plan = parsePlan(
    { version: 1, meta: { preset: 'preview' }, scenes: [{ kind: 'color', color: '#000000', duration: 1 }] },
    mkdtempSync(join(tmpdir(), 'vf-reuse-')),
  )
  const workDir = mkdtempSync(join(tmpdir(), 'vf-reuse-work-'))

  const first = await renderScene(plan.scenes[0], plan, 0, { workDir, force: true })
  assert.equal(first.reused, false)
  const second = await renderScene(plan.scenes[0], plan, 0, { workDir })
  assert.equal(second.reused, true, 'an existing clip is reused by default')
  const third = await renderScene(plan.scenes[0], plan, 0, { workDir, force: true })
  assert.equal(third.reused, false, 'force re-renders')
  assert.equal(clipPath(workDir, 0, plan.scenes[0].id), first.path)
})

test('a missing source fails with the scene named, before ffmpeg runs', async () => {
  const plan = parsePlan(
    { version: 1, meta: { preset: 'preview' }, scenes: [{ kind: 'video', source: 'nope.mp4', duration: 1 }] },
    mkdtempSync(join(tmpdir(), 'vf-missing-')),
  )
  const workDir = mkdtempSync(join(tmpdir(), 'vf-missing-work-'))
  await assert.rejects(
    () => renderScene(plan.scenes[0], plan, 0, { workDir, force: true }),
    /找不到素材/,
  )
})
