/**
 * Engine-backed checks: the accuracy claim, the coordinate claim, and the video path.
 *
 * These need a real OCR engine in `vendor/ocr/`, so they skip cleanly when none is installed —
 * the plugin works without one (Windows' recogniser stands in), and a missing engine must not
 * look like a failing build. When one IS installed, three claims are checked against a rendered
 * image rather than asserted in prose:
 *
 *   1. Small mixed-script text is read correctly. The Windows recogniser reads the very same
 *      kind of line as `TvpeScript`, which is why this module exists.
 *   2. A box reported for a cropped, enlarged copy lands inside the region in the caller's
 *      image. Getting this wrong aims clicks at the wrong place.
 *   3. A video is read frame by frame, and each frame keeps its own results.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/core/ffmpeg.mjs'
import { disposeOcrSessions, findLines, readText, resolveOcrEngine } from '../src/core/ocr.mjs'
import { findCjkFont } from '../src/core/scene.mjs'

const config = {}
const engine = resolveOcrEngine(config)
const skip = engine === null ? '没有安装离线 OCR 引擎（video_env {action:"install_ocr"}）' : false

// A warm engine is a real process: the plugin stops it when it unloads or goes idle, but a test
// process has no such moment, so without this the suite sits here until the idle timer fires.
after(() => {
  disposeOcrSessions()
})

/**
 * Render a still with two lines of text: a Chinese label and small Latin text.
 *
 * The Latin line is deliberately small — that is the case the Windows recogniser fails and this
 * engine has to pass.
 * @param {string} directory - where to write the image and its text files.
 * @returns {Promise<string>} the image path.
 */
async function renderTextImage(directory) {
  const font = findCjkFont()
  assert.ok(font !== null, 'the test needs a CJK font to render Chinese text')
  writeFileSync(join(directory, 'cn.txt'), '自动化任务', { encoding: 'utf8' })
  writeFileSync(join(directory, 'en.txt'), 'TypeScript 解析', { encoding: 'utf8' })
  const filter =
    'drawtext=' +
    `textfile='cn.txt':fontfile='${font.replace(/\\/g, '/').replace(':', '\\:')}':fontcolor=black:fontsize=44:x=60:y=60,` +
    `drawtext=textfile='en.txt':fontfile='${font.replace(/\\/g, '/').replace(':', '\\:')}':fontcolor=black:fontsize=22:x=60:y=180`
  const target = join(directory, 'text.png')
  await run({
    tool: 'ffmpeg',
    args: ['-f', 'lavfi', '-i', 'color=c=white:s=900x280', '-vf', filter, '-frames:v', '1', '-update', '1', target],
    cwd: directory,
    config,
    timeoutMs: 120_000,
  })
  return target
}

test('the offline engine reads small Chinese and Latin text off a rendered image', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-ocr-engine-'))
  try {
    const image = await renderTextImage(directory)
    const result = await readText(image, { config, engine: 'local' })

    assert.equal(result.engine, 'rapidocr-json')
    assert.ok(result.elapsedMs > 0)

    const chinese = findLines(result.lines, '自动化任务')
    assert.equal(chinese.length, 1, `expected the Chinese label, got: ${result.text}`)
    assert.ok(chinese[0].score > 0.8, 'a clean rendered label should be read with high confidence')

    const latin = findLines(result.lines, 'TypeScript')
    assert.equal(latin.length, 1, `expected the Latin label, got: ${result.text}`)
    assert.ok(latin[0].width > 0 && latin[0].height > 0, 'a match must carry a real box')
    assert.ok(latin[0].center.x > 0 && latin[0].center.y > 0, 'a match must carry a clickable centre')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a box read from a cropped, enlarged copy lands in the caller image region', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-ocr-region-'))
  try {
    const image = await renderTextImage(directory)
    // The region covers the Latin line only, with room to spare.
    const region = { x: 40, y: 160, width: 500, height: 90 }
    const cropped = await readText(image, { config, engine: 'local', region, scale: 'auto' })

    const latin = findLines(cropped.lines, 'TypeScript')
    assert.equal(latin.length, 1, `expected the Latin label inside the crop, got: ${cropped.text}`)
    const box = latin[0]

    // Back in the caller's coordinates: inside the region, and roughly where the text was drawn
    // (x=60, y=180 in the original image).
    assert.ok(box.x >= region.x && box.x < region.x + region.width, `x ${box.x} is outside the region`)
    assert.ok(box.y >= region.y && box.y < region.y + region.height, `y ${box.y} is outside the region`)
    assert.ok(Math.abs(box.x - 60) < 25, `x ${box.x} should be near the drawn x=60`)
    assert.ok(Math.abs(box.y - 180) < 25, `y ${box.y} should be near the drawn y=180`)
    assert.ok(box.width < region.width, 'the mapped box must not keep the enlarged size')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a video is read frame by frame, each frame keeping its own text', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-ocr-video-'))
  try {
    const font = findCjkFont()
    writeFileSync(join(directory, 'cn.txt'), '自动化任务', { encoding: 'utf8' })
    const clip = join(directory, 'clip.mp4')
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi', '-i', 'color=c=white:s=640x200:r=5:duration=2',
        '-vf', `drawtext=textfile='cn.txt':fontfile='${font.replace(/\\/g, '/').replace(':', '\\:')}':fontcolor=black:fontsize=40:x=40:y=70`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', clip,
      ],
      cwd: directory,
      config,
      timeoutMs: 120_000,
    })

    const result = await readText(clip, { config, engine: 'local', frames: 2 })
    assert.equal(result.kind, 'video')
    assert.equal(result.frames.length, 2)
    assert.ok(result.duration > 1.5)
    for (const frame of result.frames) {
      assert.ok(frame.at >= 0, 'each frame reports the time it was taken from')
      assert.ok(findLines(frame.lines, '自动化任务').length === 1, `frame at ${frame.at}s missed the label`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
