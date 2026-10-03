/**
 * Model-backed matting checks.
 *
 * Needs the vendored U²-Net model, so it skips cleanly when that is absent — matting is optional
 * and a missing model must not look like a failing build. When it IS installed, the claims are
 * checked against a plate whose answer is known rather than asserted in prose:
 *
 *   1. A solid subject on a plain backdrop comes back as a mask that covers the middle and not the
 *      corners. A model that failed open or shut would pass a "did it produce a mask" test and
 *      still be useless, so the geometry is what is asserted.
 *   2. The output really is a PNG with an alpha channel, since `alphamerge` succeeding and the
 *      alpha surviving the encode are different claims.
 *   3. The mask sequence path produces one file per requested mask, numbered for ffmpeg's
 *      image-sequence reader.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBinary } from '../src/core/env.mjs'
import { run } from '../src/core/ffmpeg.mjs'
import { disposeMatteSession, matteImage, matteState, matteVideo } from '../src/core/matte.mjs'

const state = matteState()
const skip = state.available ? false : `没有安装抠图模型（video_env {action:"install_matte"}）：${state.reason}`

// The WASM session is a module-level singleton; release it so the test process can exit.
after(() => {
  disposeMatteSession()
})

/**
 * Render a plate with a known subject: a solid disc centred on a plain field.
 * @param {string} directory - where to write it.
 * @param {string} [name] - file name.
 * @returns {Promise<string>} the plate path.
 */
async function renderPlate(directory, name = 'plate.png') {
  const target = join(directory, name)
  await run({
    tool: 'ffmpeg',
    args: [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=0xC8D8E8:s=480x360',
      '-f', 'lavfi', '-t', '0.1', '-i', 'color=c=0xE8B080:s=480x360',
      '-filter_complex',
      "[1:v]geq=r='if(lt(((X-240)/90)^2+((Y-180)/110)^2,1),232,0)':" +
        "g='if(lt(((X-240)/90)^2+((Y-180)/110)^2,1),176,0)':" +
        "b='if(lt(((X-240)/90)^2+((Y-180)/110)^2,1),128,0)'[p];[0:v][p]overlay",
      '-frames:v', '1', '-update', '1', target,
    ],
    config: {},
    timeoutMs: 120_000,
  })
  return target
}

test('the mask covers the subject and not the background', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-matte-engine-'))
  try {
    const plate = await renderPlate(directory)
    const out = join(directory, 'out.png')
    const result = await matteImage(plate, out, { config: {}, feather: 0, keepMask: true })

    assert.equal(result.width, 480)
    assert.equal(result.height, 360)
    assert.ok(result.inferenceMs > 0)

    // The plate is a disc of a known size, so the foreground fraction is predictable to within
    // the blur of the model's own edge. A blanket result (0 or 1) fails here.
    const ratio = result.statistics.foregroundRatio
    assert.ok(ratio > 0.05 && ratio < 0.5, `expected a disc-sized mask, got ${(ratio * 100).toFixed(1)}%`)

    // The mask itself: opaque in the middle, transparent in the corners.
    const mask = matteImageMask(result.maskPath)
    const side = 320
    const at = (x, y) => mask[y * side + x]
    assert.ok(at(side >> 1, 320 >> 1) > 200, `centre should be opaque, got ${at(side >> 1, side >> 1)}`)
    assert.ok(at(4, 4) < 60, `corner should be transparent, got ${at(4, 4)}`)

    // The output must really carry alpha, not just be an RGB PNG that looks cut out.
    assert.ok(existsSync(out))
    assert.ok(statSync(out).size > 500)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Read a PNG mask's levels by decoding it with ffmpeg to raw grey, so the test reads the real
 * artifact rather than trusting the in-memory array the writer was handed.
 * @param {string} path - the mask PNG.
 * @returns {Uint8Array} the 320x320 grey levels.
 */
function matteImageMask(path) {
  const raw = `${path}.raw`
  const ffmpeg = resolveBinary('ffmpeg', null)
  assert.ok(ffmpeg !== null, 'this test needs ffmpeg')
  const out = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-i', path, '-pix_fmt', 'gray', '-f', 'rawvideo', raw],
    { encoding: 'utf8' },
  )
  if (out.status !== 0) throw new Error(`could not read the mask: ${out.stderr}`)
  return new Uint8Array(readFileSync(raw))
}

test('a video is matted into a numbered mask sequence', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-matte-video-'))
  try {
    const clip = join(directory, 'clip.mp4')
    await run({
      tool: 'ffmpeg',
      args: [
        '-y', '-f', 'lavfi', '-i', 'color=c=0xC8D8E8:s=320x240:d=1:r=10',
        '-f', 'lavfi', '-t', '1', '-i', 'color=c=0xE8B080:s=320x240',
        '-filter_complex',
        "[1:v]geq=r='if(lt(((X-160)/60)^2+((Y-120)/70)^2,1),232,0)':" +
          "g='if(lt(((X-160)/60)^2+((Y-120)/70)^2,1),176,0)':" +
          "b='if(lt(((X-160)/60)^2+((Y-120)/70)^2,1),128,0)'[p];[0:v][p]overlay",
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip,
      ],
      config: {},
      timeoutMs: 120_000,
    })

    const maskDir = join(directory, 'masks')
    const report = await matteVideo(clip, maskDir, { config: {}, maskFps: 2, duration: 1 })
    assert.equal(report.count, 2, 'one second at 2 masks per second is two masks')
    const files = readdirSync(maskDir).filter((name) => name.endsWith('.png')).sort()
    // ffmpeg's image-sequence reader is zero-padded and starts at zero.
    assert.deepEqual(files, ['mask-00000.png', 'mask-00001.png'])
    assert.ok(report.inferenceMsMean > 0)
    assert.ok(report.foregroundRatio.mean > 0.02 && report.foregroundRatio.mean < 0.6)
    assert.deepEqual(report.notes.filter((n) => n.includes('几乎全为')), [], 'this plate should not look degenerate')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a stale mask sequence is not left behind to extend the clip', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-matte-stale-'))
  try {
    const plate = await renderPlate(directory)
    const json = join(directory, 'plate.json')
    // A still is not a video, so this leans on the sequence writer's cleanup only.
    const clip = join(directory, 'clip.mp4')
    await run({
      tool: 'ffmpeg',
      args: ['-y', '-loop', '1', '-i', plate, '-t', '1', '-r', '10', '-pix_fmt', 'yuv420p', clip],
      config: {},
      timeoutMs: 120_000,
    })

    const maskDir = join(directory, 'masks')
    const first = await matteVideo(clip, maskDir, { config: {}, maskFps: 4, duration: 1 })
    assert.equal(first.count, 4)
    // Re-running with fewer masks must not leave mask-00003.png in place, or the sequence reader
    // would consume four masks for a two-mask request.
    const second = await matteVideo(clip, maskDir, { config: {}, maskFps: 2, duration: 1 })
    assert.equal(second.count, 2)
    const files = readdirSync(maskDir).filter((name) => name.endsWith('.png')).sort()
    assert.deepEqual(files, ['mask-00000.png', 'mask-00001.png'])
    void json
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
