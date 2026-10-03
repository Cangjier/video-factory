/**
 * Regression guard for a late-stage failure that named the wrong cause.
 *
 * A plan with neither a voiceover nor music still carries a silent track, because the renderer
 * generates silence for scenes that have no audio. Passing that through `loudnorm` made ffmpeg
 * emit NaN, and the AAC encoder then refused every frame:
 *
 *     [aac] Input contains (near) NaN/+-Inf
 *     [aost] Error submitting audio frame to the encoder
 *     Conversion failed!
 *
 * The message names the encoder and never mentions loudness, so the trail led to the audio
 * filter graph only by bisecting. A plan with an empty audio block could not be rendered at all.
 *
 * These tests build a real silent timeline with ffmpeg and drive `finalize`, so the guard is a
 * genuine render rather than an assertion about a filter string.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/core/ffmpeg.mjs'
import { finalize } from '../src/core/finalize.mjs'

/**
 * Render a short video whose only audio is silence, standing in for a plan with no audio block.
 * @param {string} directory - where to write it.
 * @returns {Promise<string>} the timeline path.
 */
async function silentTimeline(directory) {
  const target = join(directory, 'timeline.mp4')
  await run({
    tool: 'ffmpeg',
    args: [
      '-f', 'lavfi', '-i', 'color=c=0x203050:s=320x180:r=25:d=1.5',
      // An explicitly silent track, which is what the scene renderer produces.
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', target,
    ],
    config: {},
    timeoutMs: 120_000,
  })
  return target
}

/**
 * A minimal plan shaped like `loadResolvedPlan` output, carrying no voiceover and no music.
 * @param {string} directory - the working directory.
 * @returns {object} the plan.
 */
function silentPlan(directory) {
  return {
    fps: 25,
    width: 320,
    height: 180,
    quality: 'draft',
    baseDir: directory,
    audio: {
      voiceover: null,
      music: null,
      keepSceneAudio: false,
      musicGainDb: -18,
      duck: true,
      fadeIn: 0,
      fadeOut: 0,
      loudnessTarget: -14,
    },
    subtitles: { enabled: false, burn: false, source: null },
  }
}

test('a plan with no voiceover and no music still renders: silence must skip loudnorm', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-finalize-'))
  try {
    const timeline = await silentTimeline(directory)
    const plan = silentPlan(directory)
    const result = await finalize(timeline, plan, {
      workDir: directory,
      outDir: directory,
      config: {},
      force: true,
    })
    assert.ok(existsSync(result.path), 'final.mp4 should exist')
    assert.ok(statSync(result.path).size > 1000, 'final.mp4 should not be a stub')
    assert.ok(result.duration > 0, 'the output should carry a duration')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
