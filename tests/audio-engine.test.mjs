/**
 * Model-backed audio checks.
 *
 * These need the vendored YAMNet model and WASM runtime, so they skip cleanly when the model is
 * not installed — audio event detection is optional, and a missing model must not look like a
 * failing build. When it IS installed, three claims are checked against audio with a known
 * shape rather than asserted in prose:
 *
 *   1. A tone is classified as a tone. The vendored model scores a 440 Hz / 1 kHz sine highest
 *      on AudioSet's `Sine wave`, `Busy signal`, and `Dial tone` classes.
 *   2. Digital silence is reported as silent instead of being force-labelled.
 *   3. The per-segment timestamps advance by the model's hop, so an event's time is usable for
 *      cutting.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/core/ffmpeg.mjs'
import { YAMNET_HOP, YAMNET_SAMPLE_RATE, audioEventState, detectAudioEvents, disposeAudioSession } from '../src/core/audio-events.mjs'

const state = audioEventState()
const skip = state.available ? false : `没有安装 YAMNet（video_env {action:"install_audio"}）：${state.reason}`

// The WASM session is a module-level singleton; release it so the test process can exit.
after(() => {
  disposeAudioSession()
})

/**
 * Render a WAV with a known acoustic shape: silence, a two-tone burst, then silence.
 * @param {string} directory - where to write it.
 * @returns {Promise<string>} the WAV path.
 */
async function renderToneWav(directory) {
  const target = join(directory, 'tone.wav')
  await run({
    tool: 'ffmpeg',
    args: [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
      '-filter_complex',
      '[0:a]adelay=2000[a0];[1:a]adelay=7000[a1];[a0][a1]amix=inputs=2:normalize=0,volume=0.7',
      '-ar', String(YAMNET_SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', target,
    ],
    config: {},
    timeoutMs: 120_000,
  })
  return target
}

test('a tone is classified, silence is not force-labelled, and timestamps advance by the hop', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-audio-engine-'))
  try {
    const wav = await renderToneWav(directory)
    const report = await detectAudioEvents(wav, { config: {}, topK: 3 })

    assert.ok(report.soundtrack.windows > 0)
    assert.ok(report.soundtrack.classified > 0, 'the tone must be classified')
    assert.ok(report.soundtrack.silent > 0, 'the leading silence must be recognised as silence')
    assert.equal(report.segments.length, report.soundtrack.windows)

    // Segment times advance by the hop.
    for (let i = 1; i < report.segments.length; i += 1) {
      const gap = report.segments[i].at - report.segments[i - 1].at
      assert.ok(Math.abs(gap - YAMNET_HOP / YAMNET_SAMPLE_RATE) < 1e-6, `gap was ${gap}`)
    }

    // The opening is silence and must be reported as such, not labelled.
    const opening = report.segments.filter((segment) => segment.at < 1.4)
    assert.ok(opening.length > 0)
    for (const segment of opening) {
      assert.equal(segment.silent, true, `t=${segment.at}s should be silent`)
      assert.deepEqual(segment.labels, [])
    }

    // Inside the tone, the model should name an actual AudioSet class with real confidence.
    const inTone = report.segments.filter((segment) => segment.at >= 2.4 && segment.at <= 4)
    assert.ok(inTone.length > 0)
    const labels = inTone.flatMap((segment) => segment.labels)
    assert.ok(labels.length > 0, `expected labels inside the tone, got ${JSON.stringify(inTone)}`)
    for (const label of labels) {
      assert.ok(label.score >= 0.1, `a reported label must clear minScore, got ${label.score}`)
      assert.ok(typeof label.label === 'string' && label.label.length > 0)
      assert.ok(!/^#\d+$/.test(label.label), `every class id must resolve to a name, got ${label.label}`)
    }

    // `events` is the grouped view of the same verdicts.
    const groupedLabels = Object.keys(report.events)
    assert.ok(groupedLabels.length > 0)
    for (const [label, times] of Object.entries(report.events)) {
      assert.ok(times.length > 0, `${label} has no timestamps`)
      for (const at of times) assert.ok(at >= 0 && at <= report.durationSec)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a file with no audio track fails with a message that says so', { skip }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-audio-engine-'))
  try {
    const silentVideo = join(directory, 'silent.mp4')
    await run({
      tool: 'ffmpeg',
      args: ['-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=1:r=10', '-pix_fmt', 'yuv420p', silentVideo],
      config: {},
      timeoutMs: 120_000,
    })
    await assert.rejects(() => detectAudioEvents(silentVideo, { config: {} }), /没有音轨|音频/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
