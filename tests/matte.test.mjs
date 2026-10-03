/**
 * Matting: the pure functions, the graph construction, and the guards.
 *
 * The learned model itself is checked in `matte-engine.test.mjs`, which skips when it is not
 * installed. What is checked here is everything that decides how the model's output is used —
 * and the two mistakes that are easy to make and hard to see:
 *
 *   1. A mask that is rescaled wrongly is a *silently* wrong mask: it looks like a mask, it
 *      composites, and the subject is subtly the wrong shape or clipped. `normaliseMask` is
 *      pinned against a known range.
 *   2. The mask sequence's declared frame rate is what makes one mask cover several output
 *      frames. Declaring the output rate instead consumes a mask per frame and runs out almost
 *      immediately, which fails loudly, but the reverse mistake — declaring it too high — just
 *      makes the matte judder and looks like a model problem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MASK_FPS,
  MAX_MASK_FPS,
  MatteError,
  maskStatistics,
  normaliseMask,
  planMasks,
  videoMatteArguments,
} from '../src/core/matte.mjs'

test('normaliseMask rescales whatever range the export used', () => {
  // Some exports return the fused sum before normalisation, so the range is not 0..1.
  const { alpha, min, max } = normaliseMask(new Float32Array([0.2, 0.6, 1.0]))
  // Float32 cannot hold 0.2 exactly, so the range is compared approximately.
  assert.ok(Math.abs(min - 0.2) < 1e-6, `min was ${min}`)
  assert.ok(Math.abs(max - 1.0) < 1e-6, `max was ${max}`)
  assert.equal(alpha[0], 0)
  assert.equal(alpha[2], 255)
  assert.ok(alpha[1] > 100 && alpha[1] < 160, `midpoint should land mid-range, got ${alpha[1]}`)
})

test('normaliseMask handles a flat mask without dividing by zero', () => {
  const { alpha } = normaliseMask(new Float32Array([0.5, 0.5, 0.5]))
  // A span of zero has no meaningful scale; the result must be finite rather than NaN.
  for (const value of alpha) assert.ok(Number.isFinite(value))
})

test('normaliseMask clamps out-of-range values instead of wrapping', () => {
  const { alpha } = normaliseMask(new Float32Array([-5, 0, 5]))
  assert.equal(alpha[0], 0)
  assert.equal(alpha[2], 255)
})

test('maskStatistics exposes a degenerate mask rather than hiding it', () => {
  const allForeground = maskStatistics(new Uint8Array(100).fill(255))
  assert.equal(allForeground.foregroundRatio, 1)
  const allBackground = maskStatistics(new Uint8Array(100).fill(0))
  assert.equal(allBackground.foregroundRatio, 0)
  const half = maskStatistics(new Uint8Array([255, 255, 0, 0]))
  assert.equal(half.foregroundRatio, 0.5)
  assert.equal(half.opaquePixels, 2)
  assert.equal(half.totalPixels, 4)
  // An empty mask must not produce NaN, which would poison every downstream comparison.
  assert.equal(maskStatistics(new Uint8Array(0)).foregroundRatio, 0)
})

test('planMasks turns a duration and a rate into a mask count, and caps it', () => {
  const plan = planMasks({ maskFps: 8, duration: 10 })
  assert.equal(plan.masks, 80)
  assert.equal(plan.durationSec, 10)

  // The cap is what stops a long clip from running away; hitting it is reported, not silent.
  const capped = planMasks({ maskFps: 30, duration: 600 })
  assert.equal(capped.masks, 900)
  assert.ok(capped.notes.length > 0, 'exceeding the cap must be reported')
  assert.match(capped.notes[0], /900/)
})

test('planMasks refuses rates and durations that cannot mean anything', () => {
  assert.throws(() => planMasks({ maskFps: 0, duration: 10 }), MatteError)
  assert.throws(() => planMasks({ maskFps: MAX_MASK_FPS + 1, duration: 10 }), MatteError)
  assert.throws(() => planMasks({ maskFps: 8, duration: 0 }), MatteError)
  assert.throws(() => planMasks({ maskFps: 8, duration: undefined }), MatteError)
  // A zero rate must not slip through as "one mask".
  try {
    planMasks({ maskFps: 0, duration: 10 })
    assert.fail('should have thrown')
  } catch (error) {
    assert.match(error.message, /maskFps/)
  }
})

test('the default mask rate is a real number inside the legal range', () => {
  assert.ok(DEFAULT_MASK_FPS > 0 && DEFAULT_MASK_FPS <= MAX_MASK_FPS)
})

test('the mask sequence is declared at maskFps, which is what makes reuse work', () => {
  const built = videoMatteArguments({
    maskDir: '/masks',
    maskCount: 4,
    maskFps: 4,
    width: 640,
    height: 360,
    fps: 24,
    duration: 2,
    background: '#102040',
  })
  const joined = built.inputs.join(' ')
  assert.match(joined, /-framerate 4\.000000 -i .*mask-%05d\.png/, 'the sequence rate must be maskFps')
  assert.ok(
    !joined.includes('24.000000 -i'),
    'declaring the sequence at the output rate would consume a mask per frame',
  )
  // The background is input 2, after the picture (0) and the masks (1).
  assert.match(built.graph, /\[2:v\]format=rgba\[bg\]/)
  // The mask is scaled to the frame, not the frame to the mask.
  assert.match(built.graph, /\[1:v\]scale=640:360/)
  assert.equal(built.notes.length, 1)
})

test('the mask rate changes how many frames one mask covers, and says so', () => {
  const slow = videoMatteArguments({ maskDir: 'm', maskCount: 2, maskFps: 2, width: 640, height: 360, fps: 30, duration: 2, background: '#000000' })
  const fast = videoMatteArguments({ maskDir: 'm', maskCount: 20, maskFps: 20, width: 640, height: 360, fps: 30, duration: 2, background: '#000000' })
  assert.match(slow.notes[0], /15\.0/)
  assert.match(fast.notes[0], /1\.5/)
})

test('a video matte without a background is refused, because the alpha would be discarded', () => {
  assert.throws(
    () => videoMatteArguments({ maskDir: 'm', maskCount: 4, maskFps: 4, width: 640, height: 360, fps: 24, duration: 2, background: null }),
    MatteError,
  )
  try {
    videoMatteArguments({ maskDir: 'm', maskCount: 4, maskFps: 4, width: 640, height: 360, fps: 24, duration: 2, background: null })
    assert.fail('should have thrown')
  } catch (error) {
    assert.match(error.message, /background/)
  }
})

test('the background input is duration bounded, so the graph has an end', () => {
  const built = videoMatteArguments({
    maskDir: 'm',
    maskCount: 4,
    maskFps: 4,
    width: 640,
    height: 360,
    fps: 24,
    duration: 3.5,
    background: '#102040',
  })
  const joined = built.inputs.join(' ')
  // An unbounded `lavfi` second input makes `overlay` emit frames forever; the picture is capped
  // by the output `-t` while the audio runs out, and the failure surfaces in the AAC encoder.
  assert.match(joined, /-f lavfi -t 3\.500 -i color=c=0x102040/)
})

test('a nonsensical mask count or size is refused before ffmpeg sees it', () => {
  const base = { maskDir: 'm', maskFps: 4, width: 640, height: 360, fps: 24, duration: 2, background: '#000000' }
  assert.throws(() => videoMatteArguments({ ...base, maskCount: 0 }), MatteError)
  assert.throws(() => videoMatteArguments({ ...base, maskCount: 1.5 }), MatteError)
  assert.throws(() => videoMatteArguments({ ...base, maskCount: 4, maskFps: 0 }), MatteError)
  assert.throws(() => videoMatteArguments({ ...base, maskCount: 4, width: 0 }), MatteError)
})
