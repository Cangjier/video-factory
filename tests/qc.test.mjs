/**
 * The quality-control core, checked without a video.
 *
 * Every judgement this feature can make is one of six comparators, and every measurement it
 * feeds them is arithmetic on numbers or on bytes. So the whole verdict path is testable
 * offline: a synthetic MP4 box order decides faststart, and a synthetic frame decides black and
 * bar detection.
 *
 * The two verdicts that matter most are not pass and fail but `skip` and `fail`-that-is-only-a-
 * warning: a case whose expectation cannot be formed must never report success, and a warning
 * must not fail the run unless the caller asked for strictness.
 *
 * Reading burned-in subtitles back was here and is now `text_read {action:"verify"}` in the
 * separate dsh-ocr plugin, together with the OCR engine it needs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CASE_CATALOGUE,
  COMPARATORS,
  QC_DEFAULTS,
  QcError,
  caseIds,
  detectBars,
  findPlaceholders,
  findRuns,
  formatQcReport,
  frameDifference,
  judgeCase,
  meanLuma,
  parseRational,
  readCaseOverrides,
  scanMp4Boxes,
  selectCases,
} from '../src/core/qc.mjs'

/** Write an ISO BMFF file with the given top-level boxes, each `type` given a body size. */
function writeBoxes(path, boxes) {
  const pieces = []
  for (const [type, body] of boxes) {
    const size = Buffer.alloc(4)
    size.writeUInt32BE(8 + body, 0)
    pieces.push(size, Buffer.from(type, 'latin1'), Buffer.alloc(body))
  }
  writeFileSync(path, Buffer.concat(pieces))
  return path
}

test('the case catalogue is well formed and its ids are unique', () => {
  const ids = caseIds()
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, CASE_CATALOGUE.length)
  for (const definition of CASE_CATALOGUE) {
    assert.ok(['error', 'warn'].includes(definition.severity), `${definition.id} severity`)
    assert.ok(COMPARATORS[definition.compares] !== undefined, `${definition.id} comparator`)
    assert.ok(Array.isArray(definition.needs) && definition.needs.length > 0, `${definition.id} needs`)
    assert.equal(typeof definition.expectation, 'function', `${definition.id} expectation`)
    assert.equal(typeof definition.measure, 'function', `${definition.id} measure`)
  }
  // The cases this project was actually burned by are present.
  for (const id of ['faststart', 'audio_duration_matches_picture', 'cues_within_audio', 'frame_count']) {
    assert.ok(ids.includes(id), `expected case ${id}`)
  }
  // Reading burned-in subtitles back is dsh-ocr's case now, not this suite's.
  assert.equal(ids.includes('burned_in_readable'), false)
})

test('scanMp4Boxes reads the box order that decides faststart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-qc-'))
  try {
    const fast = writeBoxes(join(directory, 'fast.mp4'), [['ftyp', 16], ['moov', 32], ['mdat', 64]])
    const slow = writeBoxes(join(directory, 'slow.mp4'), [['ftyp', 16], ['mdat', 64], ['moov', 32]])
    const other = join(directory, 'other.webm')
    writeFileSync(other, Buffer.from('not a box file at all'))

    const fastResult = scanMp4Boxes(fast)
    assert.equal(fastResult.fastStart, true)
    assert.deepEqual(fastResult.boxes.map((box) => box.type), ['ftyp', 'moov', 'mdat'])
    assert.match(fastResult.note, /faststart 已满足/)

    const slowResult = scanMp4Boxes(slow)
    assert.equal(slowResult.fastStart, false)
    assert.match(slowResult.note, /下载完/)

    // A container this case does not apply to reports null, which the judge turns into a skip.
    assert.equal(scanMp4Boxes(other).fastStart, null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('findRuns reports where a condition held and for how long', () => {
  const frames = [{ at: 0 }, { at: 0.5 }, { at: 1 }, { at: 1.5 }, { at: 2 }, { at: 2.5 }]
  const runs = findRuns(frames, (index) => index === 1 || index === 2)
  assert.equal(runs.length, 1)
  assert.deepEqual(runs[0], { fromSeconds: 0.5, toSeconds: 1.5, seconds: 1, frames: 2 })

  // A run that reaches the last frame ends one sampling interval after it.
  const tail = findRuns(frames, (index) => index >= 4)
  assert.equal(tail.length, 1)
  assert.equal(tail[0].fromSeconds, 2)
  assert.equal(tail[0].toSeconds, 3)
  assert.equal(findRuns(frames, () => false).length, 0)
})

test('meanLuma and frameDifference measure what they say', () => {
  const black = new Uint8Array(16)
  const white = new Uint8Array(16).fill(255)
  const gray = new Uint8Array(16).fill(128)
  assert.equal(meanLuma(black), 0)
  assert.equal(meanLuma(white), 255)
  assert.equal(meanLuma(gray), 128)
  assert.equal(frameDifference(black, black), 0)
  assert.equal(frameDifference(black, white), 255)
  assert.equal(frameDifference(new Uint8Array(4), new Uint8Array(9)), Number.POSITIVE_INFINITY)
})

test('detectBars finds letterbox and pillarbox bars, and not a dark scene', () => {
  const width = 20
  const height = 20
  const letterbox = new Uint8Array(width * height).fill(120)
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < width; x += 1) letterbox[y * width + x] = 2
  }
  const found = detectBars(letterbox, width, height)
  assert.equal(found.top, 0.2)
  assert.equal(found.bottom, 0)
  assert.equal(found.left, 0)

  const pillar = new Uint8Array(width * height).fill(120)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < 3; x += 1) pillar[y * width + x] = 1
  }
  assert.equal(detectBars(pillar, width, height).left, 0.15)

  // A uniformly dark frame is a dark scene, not a bar: there is no brighter interior.
  const dark = new Uint8Array(width * height).fill(3)
  const darkBars = detectBars(dark, width, height)
  assert.equal(Math.max(darkBars.top, darkBars.bottom, darkBars.left, darkBars.right), 0)
})

test('findPlaceholders catches what must never ship', () => {
  assert.deepEqual(findPlaceholders('这是一句正常的字幕'), [])
  assert.equal(findPlaceholders('TODO: 补上这一段').length, 1)
  assert.equal(findPlaceholders('标题 {{title}}').length, 1)
  assert.equal(findPlaceholders('坏字 \uFFFD 在这里').length, 1)
  assert.equal(findPlaceholders('Lorem Ipsum dolor').length, 1)
})

test('judgeCase turns an unformable expectation into a skip with a reason', () => {
  const definition = {
    id: 'demo',
    category: 'demo',
    title: '演示',
    severity: 'error',
    compares: 'equals',
    needs: ['plan'],
    expectation: (context) => (context.plan === null ? null : { target: 1 }),
    expectationReason: '需要 plan。',
    measure: () => 1,
  }
  const skipped = judgeCase(definition, { plan: null })
  assert.equal(skipped.status, 'skip')
  assert.equal(skipped.detail, '需要 plan。')
  assert.equal(judgeCase(definition, { plan: {} }).status, 'pass')
})

test('judgeCase skips when the measurement is missing and fails when it disagrees', () => {
  const definition = {
    id: 'demo',
    category: 'demo',
    title: '演示',
    severity: 'warn',
    compares: 'atMost',
    needs: ['audio'],
    expectation: () => ({ limit: 1 }),
    measure: (context) => context.audio?.value ?? null,
  }
  assert.equal(judgeCase(definition, { audio: null }).status, 'skip')
  assert.equal(judgeCase(definition, { audio: { value: 0.5 } }).status, 'pass')
  const failed = judgeCase(definition, { audio: { value: 2 } })
  assert.equal(failed.status, 'fail')
  assert.equal(failed.severity, 'warn')
  assert.equal(failed.delta, 1)
  // The case file may retune the severity; it cannot change the arithmetic.
  assert.equal(judgeCase(definition, { audio: { value: 2 } }, { severity: 'error' }).severity, 'error')
  assert.equal(judgeCase(definition, { audio: { value: 2 } }, { enabled: false }).status, 'skip')
})

test('every comparator answers with a boolean and a delta', () => {
  assert.equal(COMPARATORS.within(10, { target: 10, tolerance: 0 }).ok, true)
  assert.equal(COMPARATORS.within(10.2, { target: 10, tolerance: 0.1 }).ok, false)
  assert.equal(COMPARATORS.within(Number.POSITIVE_INFINITY, { target: 10, tolerance: 1 }).ok, false)
  assert.equal(COMPARATORS.atLeast(5, { limit: 5 }).ok, true)
  assert.equal(COMPARATORS.atMost(5, { limit: 4 }).ok, false)
  assert.equal(COMPARATORS.equals('yuv420p', { target: 'yuv420p' }).ok, true)
  assert.equal(COMPARATORS.equals(null, { target: 'yuv420p' }).ok, false)
  const runs = [{ seconds: 0.5 }, { seconds: 3 }]
  assert.equal(COMPARATORS.runsAtMost(runs, { limitSeconds: 1 }).ok, false)
  assert.equal(COMPARATORS.runsAtMost([], { limitSeconds: 1 }).ok, true)
  assert.equal(COMPARATORS.clean([], { target: [] }).ok, true)
  assert.equal(COMPARATORS.clean(['TODO'], { target: [] }).ok, false)
})

test('selectCases honours only, skip and a disabled case file entry', () => {
  const overrides = readCaseOverrides({ cases: { faststart: { enabled: false }, width: { severity: 'warn' } } })
  assert.equal(selectCases({ overrides }).selected.some((entry) => entry.id === 'faststart'), false)
  assert.equal(overrides.get('width').severity, 'warn')

  const only = selectCases({ only: ['faststart', 'width'] })
  assert.deepEqual(only.selected.map((entry) => entry.id), ['faststart', 'width'])
  assert.deepEqual(only.unknown, [])

  const unknown = selectCases({ only: ['nope'] })
  assert.deepEqual(unknown.unknown, ['nope'])
  assert.equal(selectCases({ skip: ['faststart'] }).selected.some((entry) => entry.id === 'faststart'), false)

  // A case file may also be a bare map, which is what a hand-written file often looks like.
  assert.equal(readCaseOverrides({ faststart: { enabled: false } }).get('faststart').enabled, false)
  assert.equal(readCaseOverrides(null).size, 0)
})

test('parseRational reads the frame rates ffprobe reports', () => {
  assert.equal(parseRational('30/1'), 30)
  assert.equal(parseRational('30000/1001'), 30000 / 1001)
  assert.equal(parseRational('0/0'), null)
  assert.equal(parseRational(''), null)
  assert.equal(parseRational(undefined), null)
})

test('formatQcReport prints one marked line per case and lists what was skipped', () => {
  const text = formatQcReport({
    ok: false,
    target: 'out/final.mp4',
    planPath: 'plan.json',
    strict: false,
    counts: { total: 3, passed: 1, failed: 1, warned: 0, skipped: 1 },
    results: [
      { id: 'faststart', category: 'container', status: 'pass', severity: 'error', expected: { target: true }, actual: true, delta: null, detail: '满足期望。' },
      { id: 'duration', category: 'video', status: 'fail', severity: 'error', expected: { target: 10, tolerance: 0.1 }, actual: 9.2, delta: -0.8, detail: '不满足期望。' },
      { id: 'loudness_target', category: 'audio', status: 'skip', severity: 'error', expected: null, actual: null, delta: null, detail: '需要 plan。' },
    ],
    skippedReasons: [{ id: 'loudness_target', reason: '需要 plan。' }],
    notes: [],
  })
  assert.match(text, /video_qc 未通过：1 通过 \/ 1 失败 \/ 0 警告 \/ 1 跳过/)
  assert.match(text, /PASS container\/faststart/)
  assert.match(text, /FAIL video\/duration/)
  assert.match(text, /SKIP audio\/loudness_target/)
  assert.match(text, /跳过 1 条/)
})

test('the documented defaults are the ones the catalogue falls back to', () => {
  assert.equal(QC_DEFAULTS.probeFps, 2)
  assert.equal(QC_DEFAULTS.maxBlackRunSeconds, 1)
  assert.equal(QC_DEFAULTS.durationToleranceSeconds, 0.1)
  assert.ok(QC_DEFAULTS.truePeakCeilingDbtp <= -1)
  // Subtitle read-back thresholds used to live here; they moved to dsh-ocr with the case.
  assert.equal(QC_DEFAULTS.subtitleMatchRatio, undefined)
  assert.ok(new QcError('x') instanceof Error)
})
