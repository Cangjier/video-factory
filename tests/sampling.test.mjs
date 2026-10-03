/**
 * Frame sampling: the arithmetic, the policy, and the reason reporting.
 *
 * The selection half is a pure function over scores, so it is tested here without decoding a
 * single video. That is deliberate — the thresholds encode a policy, and a policy that only
 * exists inside an ffmpeg invocation cannot be checked.
 *
 * The decode half is exercised against a rendered video so the ffmpeg plumbing (argument
 * order, raw `gray` framing, the stdout buffer path) is covered too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/core/ffmpeg.mjs'
import {
  SAMPLING_DEFAULTS,
  SamplingError,
  decodeLuma,
  meanAbsoluteDifference,
  normaliseSamplingOptions,
  sampleFrames,
  scoreFrames,
  selectFrames,
} from '../src/core/sampling.mjs'

/** A luma frame of one repeated value. */
function flat(value, length = 4) {
  return new Uint8Array(length).fill(value)
}

/**
 * Build scored candidates from explicit scores, one per probe frame.
 *
 * `null` marks the first frame, which has no predecessor and therefore no score.
 * @param {Array<number|null>} scores - the per-frame scores.
 * @param {number} [fps] - probe frames per second, used to derive each frame's time.
 * @returns {Array<{index: number, at: number, sceneScore: number|null}>} the candidates.
 */
function candidates(scores, fps = 4) {
  return scores.map((score, index) => ({ index, at: index / fps, sceneScore: score }))
}

test('meanAbsoluteDifference is zero for identical frames and the mean gap otherwise', () => {
  assert.equal(meanAbsoluteDifference(flat(10), flat(10)), 0)
  assert.equal(meanAbsoluteDifference(flat(0), flat(10)), 10)
  // Half the pixels move by 20: the mean is 10, not 20.
  assert.equal(meanAbsoluteDifference(new Uint8Array([0, 0, 0, 0]), new Uint8Array([20, 20, 0, 0])), 10)
})

test('meanAbsoluteDifference refuses frames of different lengths', () => {
  assert.throws(() => meanAbsoluteDifference(flat(0, 4), flat(0, 8)), SamplingError)
})

test('scoreFrames gives the first frame no score rather than a fabricated zero', () => {
  const frames = [
    { index: 0, at: 0, luma: flat(0) },
    { index: 1, at: 0.25, luma: flat(0) },
    { index: 2, at: 0.5, luma: flat(40) },
  ]
  const scored = scoreFrames(frames)
  assert.equal(scored[0].sceneScore, null, 'the first frame has no predecessor')
  assert.equal(scored[1].sceneScore, 0)
  assert.equal(scored[2].sceneScore, 40)
})

test('normaliseSamplingOptions fills defaults and rejects nonsense', () => {
  const defaults = normaliseSamplingOptions()
  assert.equal(defaults.strategy, SAMPLING_DEFAULTS.strategy)
  assert.equal(defaults.probeFps, SAMPLING_DEFAULTS.probeFps)

  assert.throws(() => normaliseSamplingOptions({ strategy: 'vibes' }), SamplingError)
  assert.throws(() => normaliseSamplingOptions({ probeFps: 0 }), SamplingError)
  assert.throws(() => normaliseSamplingOptions({ probeFps: 999 }), SamplingError)
  // 800x600 is over the area cap.
  assert.throws(() => normaliseSamplingOptions({ probeWidth: 800, probeHeight: 600 }), SamplingError)
  assert.throws(() => normaliseSamplingOptions({ probeWidth: 8 }), SamplingError)
  assert.throws(() => normaliseSamplingOptions({ minFps: 8, maxFps: 2 }), SamplingError)
})

test('the first frame is always selected, even with no score at all', () => {
  const { selected } = selectFrames(candidates([null]))
  assert.equal(selected.length, 1)
  assert.equal(selected[0].reason, 'first_frame')
  assert.equal(selected[0].sceneScore, null, 'no score is reported, not a zero')
})

test('a static video samples on its cadence instead of collapsing to one frame', () => {
  // probeFps 4, targetFps 1 => targetInterval 4 => one frame per second, which is exactly
  // what the cadence is for: a still shot still has to be looked at occasionally.
  const scores = [null, ...Array.from({ length: 63 }, () => 0)]
  const { selected } = selectFrames(candidates(scores))
  assert.ok(selected.length > 1, 'a static video must not sample to nothing')
  const periodic = selected.filter((frame) => frame.reason === 'periodic')
  assert.ok(periodic.length > 0, 'a zero score should fall through to the cadence')
  for (const frame of periodic) assert.ok(frame.gapFromPrevious >= 4)
})

test('with an unreachable cadence the maxInterval fallback is what keeps a still video alive', () => {
  // targetFps far above probeFps makes targetInterval equal maxInterval in practice, so the
  // fallback branch is the one that has to fire.
  const scores = [null, ...Array.from({ length: 63 }, () => 0)]
  const { selected } = selectFrames(candidates(scores), { targetFps: 0.1 })
  const fallbacks = selected.filter((frame) => frame.reason === 'max_interval_fallback')
  assert.ok(fallbacks.length > 0, 'a static video must not sample to nothing')
  assert.equal(fallbacks[0].index, 16, 'probeFps 4 / minFps 0.25 puts maxInterval at 16 frames')
})

test('adaptive picks up a cut that uniform would only reach on its cadence', () => {
  const scores = [null, ...Array.from({ length: 63 }, () => 18)]
  scores[7] = 55 // a hard cut at frame 7
  const adaptive = selectFrames(candidates(scores), { strategy: 'adaptive' })
  const cut = adaptive.selected.find((frame) => frame.index === 7)
  assert.ok(cut !== undefined, 'the cut should be selected')
  assert.equal(cut.reason, 'scene_change')

  const uniform = selectFrames(candidates(scores), { strategy: 'uniform' })
  assert.equal(
    uniform.selected.find((frame) => frame.index === 7),
    undefined,
    'uniform ignores the score by definition',
  )
})

test('scene_change and motion_aware use different thresholds on the same scores', () => {
  // A score of 6 is motion but not a cut, given the defaults (scene 30, motion 5).
  const scores = [null, ...Array.from({ length: 31 }, () => 6)]
  const byScene = selectFrames(candidates(scores), { strategy: 'scene_change' })
  const byMotion = selectFrames(candidates(scores), { strategy: 'motion_aware' })

  assert.equal(
    byScene.selected.filter((frame) => frame.reason === 'scene_change').length,
    0,
    'a score of 6 is below the cut threshold',
  )
  assert.ok(
    byMotion.selected.filter((frame) => frame.reason === 'motion').length > 0,
    'a score of 6 is above the motion threshold',
  )
})

test('maxFrames caps the result', () => {
  const scores = [null, ...Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 60 : 60))]
  const { selected } = selectFrames(candidates(scores), { maxFrames: 5 })
  assert.equal(selected.length, 5)
})

test('the kept cadence never exceeds maxFps', () => {
  // Every frame is a huge scene change, so only the cadence ceiling can hold it back.
  const scores = [null, ...Array.from({ length: 79 }, () => 200)]
  const { selected } = selectFrames(candidates(scores), { maxFps: 2, probeFps: 4, maxFrames: 1000 })
  for (let i = 1; i < selected.length; i += 1) {
    assert.ok(
      selected[i].index - selected[i - 1].index >= 2,
      `gap ${selected[i].index - selected[i - 1].index} is below the minInterval of 2`,
    )
  }
})

test('selectFrames reports why each frame was kept, and how far back the previous one was', () => {
  const scores = [null, 0, 0, 0, 0, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const { selected, skipped, strategy } = selectFrames(candidates(scores))
  assert.equal(strategy, 'adaptive')
  assert.equal(skipped, 18 - selected.length)
  for (const frame of selected) {
    assert.ok(typeof frame.reason === 'string' && frame.reason.length > 0)
    assert.ok(frame.index >= 0)
    if (frame.gapFromPrevious !== null) assert.ok(frame.gapFromPrevious > 0)
  }
  const cut = selected.find((frame) => frame.index === 8)
  assert.equal(cut.reason, 'scene_change')
  assert.equal(cut.sceneScore, 90)
  assert.equal(cut.motionScore, 90, 'the two scores are the same measurement, reported under both names')
})

test('decodeLuma reads a rendered video as raw grayscale frames', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-sampling-'))
  const video = join(directory, 'flat.mp4')
  try {
    // One second of solid mid-grey at 24 fps.
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=1:r=24',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-t', '1', video,
      ],
      config: {},
      timeoutMs: 120_000,
    })

    // Probe at 4 fps into 32x18 so the frame arithmetic is easy to check by hand.
    const decoded = await decodeLuma(video, { config: {}, probeFps: 4, probeWidth: 32, probeHeight: 18 })
    assert.equal(decoded.width, 32)
    assert.equal(decoded.height, 18)
    // Frame count follows the source duration and the requested probe rate, with an edge
    // frame either way allowed depending on where the encoder put the last sample.
    assert.ok(decoded.frames.length >= 4 && decoded.frames.length <= 5, `got ${decoded.frames.length} frames`)
    assert.equal(decoded.frames[0].luma.length, 32 * 18)
    assert.equal(decoded.frames[0].at, 0)

    // Solid grey means consecutive frames are identical.
    const scored = scoreFrames(decoded.frames)
    assert.equal(scored[1].sceneScore, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('sampleFrames reports the geometry and thresholds it actually used', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-sampling-'))
  const video = join(directory, 'cuts.mp4')
  try {
    // Four one-second colour blocks: the three boundaries are hard cuts.
    await run({
      tool: 'ffmpeg',
      args: [
        '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1:r=24',
        '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1:r=24',
        '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1:r=24',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
        '-map', '[out]', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video,
      ],
      config: {},
      timeoutMs: 180_000,
    })

    const report = await sampleFrames(video, { config: {}, probeFps: 8 })
    assert.equal(report.probe.fps, 8)
    assert.equal(report.probe.width, SAMPLING_DEFAULTS.probeWidth)
    assert.equal(report.thresholds.sceneThreshold, SAMPLING_DEFAULTS.sceneThreshold)
    assert.equal(report.strategy, 'adaptive')
    assert.ok(report.frames.length >= 3)
    assert.equal(report.frames[0].reason, 'first_frame')

    const cuts = report.frames.filter((frame) => frame.reason === 'scene_change')
    assert.ok(cuts.length >= 2, `expected the colour boundaries to be detected, got ${JSON.stringify(report.frames)}`)
    // The score is a luma difference, so it is bounded by the luma range rather than by how
    // different the colours look: pure red is luma 76 and pure blue is 29, giving a mean gap
    // near 46. What matters is that it clears the cut threshold, not that it is large.
    for (const cut of cuts) {
      assert.ok(
        cut.sceneScore >= SAMPLING_DEFAULTS.sceneThreshold,
        `a cut must clear the threshold of ${SAMPLING_DEFAULTS.sceneThreshold}, got ${cut.sceneScore}`,
      )
      assert.equal(cut.reason, 'scene_change')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a file that is not a video fails with a readable message', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-sampling-'))
  try {
    await assert.rejects(
      () => sampleFrames(join(directory, 'missing.mp4'), { config: {} }),
      /文件不存在|无法确定视频时长/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
