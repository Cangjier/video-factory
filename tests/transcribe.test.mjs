/**
 * Offline checks for audio preparation and request splitting.
 *
 * The recogniser caps one request at 4 MB (about 131 seconds of 16 kHz mono PCM16), so
 * anything longer has to be split. Where it is split matters: a byte-offset cut lands
 * mid-word and surfaces as a truncated word nobody can explain. These tests pin the
 * split planner's behaviour, including when it has to give up and cut hard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BYTES_PER_SECOND,
  DEFAULT_MAX_AUDIO_BYTES,
  SAMPLE_RATE,
  TranscribeError,
  parseSilences,
  planCuts,
  toCanonicalWav,
  transcribeFile,
} from '../src/core/transcribe.mjs'

test('the byte budget converts to a plausible number of seconds', () => {
  assert.equal(SAMPLE_RATE, 16_000)
  assert.equal(BYTES_PER_SECOND, 32_000)
  // The host's 4 MB cap is roughly 131 seconds, which is why the splitter exists.
  const seconds = DEFAULT_MAX_AUDIO_BYTES / BYTES_PER_SECOND
  assert.ok(seconds > 120 && seconds < 140, `expected ~131s, got ${seconds}`)
})

test('parseSilences reads ffmpeg silencedetect output', () => {
  const stderr = [
    '[silencedetect @ 0000] silence_start: 3.456',
    '[silencedetect @ 0000] silence_end: 4.1 | silence_duration: 0.644',
    '[silencedetect @ 0000] silence_start: 12.0',
    '[silencedetect @ 0000] silence_end: 12.9 | silence_duration: 0.9',
  ].join('\n')

  const silences = parseSilences(stderr)
  assert.equal(silences.length, 2)
  assert.equal(silences[0].start, 3.456)
  assert.equal(silences[0].end, 4.1)
  assert.equal(silences[1].start, 12)
  assert.equal(silences[1].end, 12.9)
})

test('parseSilences tolerates an unterminated silence and negative starts', () => {
  const silences = parseSilences(
    ['silence_start: 2.5', 'silence_start: 9.0', 'silence_start: -0.01'].join('\n'),
  )
  // The last one is unterminated; the negative one is dropped because it cannot be a cut.
  assert.deepEqual(silences, [
    { start: 2.5, end: null },
    { start: 9.0, end: null },
  ])
  assert.deepEqual(parseSilences(''), [])
})

test('planCuts needs no cuts when the audio already fits', () => {
  const plan = planCuts({ totalSeconds: 60, silences: [], maxBytes: DEFAULT_MAX_AUDIO_BYTES })
  assert.deepEqual(plan.cuts, [])
  assert.equal(plan.forced, 0)
})

test('planCuts prefers a detected pause over a hard cut', () => {
  // 300s of audio at 120s per request needs two cuts, and every candidate pause is
  // inside the tolerated window, so nothing should be forced.
  const silences = [
    { start: 30, end: 30.5 },
    { start: 100, end: 100.6 },
    { start: 118, end: 118.8 },
    { start: 200, end: 200.5 },
    { start: 230, end: 230.9 },
    { start: 275, end: 275.5 },
  ]
  const plan = planCuts({ totalSeconds: 300, silences, maxBytes: 120 * BYTES_PER_SECOND, leadSeconds: 25 })
  assert.equal(plan.forced, 0, 'pauses were available, so no cut should be forced')
  assert.ok(plan.cuts.length >= 2)
  // Every cut must be at a real pause, and each piece must respect the budget.
  const pauseStarts = new Set(silences.map((silence) => silence.start))
  let cursor = 0
  for (const cut of plan.cuts) {
    assert.ok(pauseStarts.has(cut), `cut at ${cut} is not a detected pause`)
    assert.ok(cut - cursor <= 120, `piece of ${cut - cursor}s exceeds the budget`)
    cursor = cut
  }
  assert.ok(300 - cursor <= 120)
})

test('planCuts cuts hard, and says so, when there is no pause to use', () => {
  // Continuous speech with no silences at all.
  const plan = planCuts({ totalSeconds: 300, silences: [], maxBytes: 120 * BYTES_PER_SECOND })
  assert.equal(plan.forced, plan.cuts.length)
  assert.ok(plan.forced >= 2)
  for (const [index, cut] of plan.cuts.entries()) {
    const previous = index === 0 ? 0 : plan.cuts[index - 1]
    assert.ok(Math.abs(cut - previous - 120) < 1e-6, 'a forced cut must land exactly on the budget')
  }
})

test('planCuts ignores pauses that are too early to be useful', () => {
  // A pause 2 seconds in would make a uselessly short first piece.
  const plan = planCuts({
    totalSeconds: 300,
    silences: [{ start: 2, end: 2.5 }, { start: 119, end: 119.6 }],
    maxBytes: 120 * BYTES_PER_SECOND,
    leadSeconds: 25,
  })
  assert.ok(plan.cuts[0] >= 120 * 0.25, `first cut at ${plan.cuts[0]} is too early to be worth taking`)
})

test('toCanonicalWav produces the exact format the recogniser validates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-wav-'))
  const target = join(directory, 'out.wav')
  // A one-second tone is enough to exercise the conversion; the recogniser would need a
  // real voice, but the header and sample layout are what is under test here.
  const { run } = await import('../src/core/ffmpeg.mjs')
  const tone = join(directory, 'tone.mp3')
  await run({ tool: 'ffmpeg', args: ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone] })

  const result = await toCanonicalWav(tone, target)
  assert.ok(result.bytes > 0)
  assert.ok(Math.abs(result.seconds - 1) < 0.1, `expected ~1s, got ${result.seconds}`)

  const { open } = await import('node:fs/promises')
  const handle = await open(target, 'r')
  const head = Buffer.alloc(4096)
  const read = (await handle.read(head, 0, 4096, 0)).bytesRead
  await handle.close()
  const header = head.subarray(0, read)

  assert.equal(header.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(header.subarray(8, 12).toString('ascii'), 'WAVE')

  // Walk the chunks rather than assuming the textbook 44-byte layout: ffmpeg inserts a
  // LIST chunk before `data`, so `fmt ` is not at 12 and `data` is not at 36.
  let cursor = 12
  let dataOffset = -1
  let dataSize = 0
  while (cursor + 8 <= header.length) {
    const id = header.subarray(cursor, cursor + 4).toString('ascii')
    const size = header.readUInt32LE(cursor + 4)
    if (id === 'data') {
      dataOffset = cursor + 8
      dataSize = size
      break
    }
    if (id === 'fmt ') {
      // Offsets are relative to the chunk's data, which starts at cursor + 8.
      assert.equal(header.readUInt16LE(cursor + 10), 1, 'one channel')
      assert.equal(header.readUInt32LE(cursor + 12), 16_000, '16 kHz')
      assert.equal(header.readUInt16LE(cursor + 22), 16, '16-bit samples')
    }
    cursor += 8 + size + (size % 2)
  }

  assert.ok(dataOffset > 0, 'the file must contain a data chunk')
  // The whole point of the header repair: this field must describe the real audio, because
  // the recogniser trusts it and ffmpeg leaves a placeholder there.
  assert.equal(dataSize, result.bytes - dataOffset, 'the data-chunk size must match the actual payload')
  assert.ok(dataSize > 30_000, `expected about a second of samples, got ${dataSize} bytes`)
})

test('toCanonicalWav reports a clear failure for an unreadable input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-wav-bad-'))
  const broken = join(directory, 'broken.mp3')
  writeFileSync(broken, 'not audio')
  await assert.rejects(() => toCanonicalWav(broken, join(directory, 'out.wav')), TranscribeError)
})

test('transcribeFile explains how to enable the recogniser when the service is absent', async () => {
  // This is the message a user sees on a profile without the speech bundle, so it must
  // name the bundle rather than failing obscurely.
  await assert.rejects(
    () => transcribeFile({ source: 'anything.wav', service: undefined }),
    /voice-input-bundle/,
  )
})
