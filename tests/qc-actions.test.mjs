/**
 * The acceptance suite against real files, including files that are wrong on purpose.
 *
 * A quality gate is only worth having if it fails when it should, so this test builds three
 * deliveries: a good one, one whose index sits at the end of the file (no faststart), and one
 * whose audio track stops two seconds before its picture — the failure that motivated the whole
 * audio family. Each broken file must trip exactly the case that describes it, and the good one
 * must trip no error-severity case at all.
 *
 * The fixtures are generated with the vendored ffmpeg at the canvas the plan names, so the
 * plan-derived expectations are real rather than hand-written numbers.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/core/ffmpeg.mjs'
import { loadResolvedPlan } from '../src/core/plan.mjs'
import { QC_DEFAULTS, caseIds, runQc } from '../src/core/qc.mjs'
import { createQcActions } from '../src/tools/qc-actions.mjs'
import { createQcTool } from '../src/tools/qc.mjs'

const config = {}
let directory
let plan
let planPath
let voice
let good
let noFaststart
let shortAudio
let blackTail

const logger = { info() {}, warn() {}, error() {} }

/** Encode the reference delivery: moving picture plus a tone at the plan's loudness target. */
async function encodeDelivery(target, { faststart = true, audioSeconds = 4, seconds = 4, blackTailSeconds = 0 } = {}) {
  const args = [
    '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${plan.width}x${plan.height}:rate=${plan.fps}:duration=${seconds}`,
  ]
  const filters = []
  if (blackTailSeconds > 0) {
    args.push('-f', 'lavfi', '-i', `color=black:size=${plan.width}x${plan.height}:rate=${plan.fps}:duration=${blackTailSeconds}`)
    filters.push(`[0:v][1:v]concat=n=2:v=1:a=0[v]`)
  }
  if (audioSeconds > 0) {
    args.push('-f', 'lavfi', '-i', `aevalsrc=sin(2*PI*1000*t):s=48000:d=${audioSeconds}:c=mono`, '-af', 'volume=-11dB')
  }
  args.push(
    ...(filters.length > 0 ? ['-filter_complex', filters.join(';'), '-map', '[v]'] : ['-map', '0:v']),
    ...(audioSeconds > 0 ? ['-map', `${filters.length > 0 ? 2 : 1}:a`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    ...(audioSeconds > 0 ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    ...(faststart ? ['-movflags', '+faststart'] : []),
    target,
  )
  await run({ tool: 'ffmpeg', args, config, timeoutMs: 5 * 60 * 1000 })
  return target
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'vf-qc-run-'))
  voice = join(directory, 'voice.wav')
  await run({
    tool: 'ffmpeg',
    args: ['-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=sin(2*PI*1000*t):s=48000:d=4:c=mono', '-af', 'volume=-11dB', '-c:a', 'pcm_s16le', voice],
    config,
  })

  planPath = join(directory, 'plan.json')
  writeFileSync(
    planPath,
    `${JSON.stringify(
      {
        version: 1,
        meta: { title: 'qc fixture', preset: 'preview', quality: 'medium' },
        audio: { voiceover: 'voice.wav' },
        subtitles: { enabled: false },
        scenes: [{ id: 's01', kind: 'color', color: '#101010', duration: 4 }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  plan = loadResolvedPlan(planPath)

  good = await encodeDelivery(join(directory, 'good.mp4'), { faststart: true, audioSeconds: 4 })
  noFaststart = await encodeDelivery(join(directory, 'no-faststart.mp4'), { faststart: false, audioSeconds: 4 })
  shortAudio = await encodeDelivery(join(directory, 'short-audio.mp4'), { faststart: true, audioSeconds: 2 })
  blackTail = await encodeDelivery(join(directory, 'black-tail.mp4'), { faststart: true, audioSeconds: 0, seconds: 2, blackTailSeconds: 3 })
})

after(() => {
  rmSync(directory, { recursive: true, force: true })
})

test('a delivery that satisfies the plan trips no error-severity case', async () => {
  const result = await runQc({ target: good, plan, planPath, config, ocr: false })
  const failed = result.results.filter((entry) => entry.status === 'fail')
  assert.deepEqual(
    failed.filter((entry) => entry.severity === 'error').map((entry) => `${entry.id}: ${entry.detail}`),
    [],
    'no error-severity case may fail on a correct delivery',
  )
  assert.equal(result.ok, true)
  assert.equal(result.counts.total, caseIds().length)

  const byId = new Map(result.results.map((entry) => [entry.id, entry]))
  for (const id of [
    'faststart',
    'one_video_stream',
    'audio_stream_count',
    'width',
    'height',
    'fps',
    'duration',
    'frame_count',
    'pixel_format',
    'audio_present',
    'audio_duration_matches_picture',
    'loudness_target',
    'true_peak',
  ]) {
    assert.equal(byId.get(id).status, 'pass', `${id} should pass: ${JSON.stringify(byId.get(id))}`)
  }
  // Cases that need an input the fixture does not have say so instead of passing.
  assert.equal(byId.get('cover_frame').status, 'skip')
  assert.ok(result.skippedReasons.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0))
})

test('an index at the end of the file fails the faststart case', async () => {
  const result = await runQc({ target: noFaststart, plan, planPath, config, ocr: false, only: ['faststart'] })
  assert.equal(result.counts.total, 1)
  assert.equal(result.results[0].status, 'fail')
  assert.equal(result.results[0].actual, false)
  assert.match(result.results[0].detail, /下载完/)
  assert.equal(result.ok, false)
})

test('an audio track that stops early fails the case about it, and only that one', async () => {
  const result = await runQc({
    target: shortAudio,
    config,
    ocr: false,
    only: ['audio_duration_matches_picture', 'cues_within_audio', 'duration'],
  })
  const byId = new Map(result.results.map((entry) => [entry.id, entry]))
  const audioCase = byId.get('audio_duration_matches_picture')
  assert.equal(audioCase.status, 'fail')
  assert.equal(audioCase.severity, 'error')
  assert.ok(Math.abs(audioCase.actual - 2) < 0.12, `audio should be about 2s, got ${audioCase.actual}`)
  assert.ok(Math.abs(audioCase.expected.target - 4) < 0.12)
  assert.match(audioCase.detail, /只有字幕没有声音|没有声音/)
  // No plan was given, so the picture-duration case skips rather than guessing.
  assert.equal(byId.get('duration').status, 'skip')
  assert.equal(result.ok, false)
})

test('a video whose tail is black fails the black-frame case and nothing else', async () => {
  const result = await runQc({ target: blackTail, config, ocr: false, only: ['black_frames', 'frozen_frames'] })
  const byId = new Map(result.results.map((entry) => [entry.id, entry]))
  const black = byId.get('black_frames')
  assert.equal(black.status, 'fail')
  assert.equal(black.severity, 'warn')
  assert.ok(Math.max(...black.actual.map((run) => run.seconds)) >= 1, `expected a long black run, got ${JSON.stringify(black.actual)}`)
  assert.match(black.detail, /最长黑帧/)
  // A warning does not fail the run, which is exactly the difference from an error.
  assert.equal(result.ok, true)
  assert.equal(byId.get('frozen_frames').status, 'pass')
})

test('a case file retunes thresholds and severities without adding judgements', async () => {
  const casesPath = join(directory, 'qc-cases.json')
  writeFileSync(
    casesPath,
    `${JSON.stringify(
      {
        cases: {
          black_frames: { enabled: false },
          letterbox: { severity: 'error' },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const actions = createQcActions(config, logger)
  const listed = await actions.cases({ casesPath }, { cwd: directory })
  assert.equal(listed.cases.find((entry) => entry.id === 'black_frames').enabled, false)
  assert.equal(listed.cases.find((entry) => entry.id === 'letterbox').severity, 'error')

  const reportPath = join(directory, 'qc-report.json')
  const checked = await actions.check(
    { target: blackTail, casesPath, reportPath, ocr: false, only: ['black_frames', 'frozen_frames', 'letterbox'] },
    { cwd: directory },
  )
  assert.equal(checked.counts.total, 2, 'the disabled case must not run')
  assert.equal(checked.results ?? null, null)
  assert.ok(existsSync(reportPath))
  const written = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(written.counts.total, 2)
  assert.equal(written.results.find((entry) => entry.id === 'letterbox').severity, 'error')
  assert.match(checked.text, /video_qc/)
})

test('the tool exposes every action and runs one end to end', async () => {
  const actions = createQcActions(config, logger)
  const tool = createQcTool(actions)
  assert.deepEqual(Object.keys(actions).sort(), ['cases', 'check', 'picture', 'structure'].sort())

  const catalogue = await tool.execute({ action: 'cases' }, { cwd: directory })
  assert.equal(catalogue.count, caseIds().length)
  assert.ok(catalogue.defaults.loudnessToleranceLu > 0)

  const checked = await tool.execute({ action: 'check', target: good, plan: planPath, only: ['faststart', 'audio_present'] }, { cwd: directory })
  assert.equal(checked.action, 'check')
  assert.equal(checked.ok, true)
  assert.equal(checked.counts.total, 2)

  const structure = await tool.execute({ action: 'structure', target: shortAudio }, { cwd: directory })
  assert.ok(Math.abs(structure.audioSeconds - 2) < 0.12)
  assert.ok(Math.abs(structure.videoSeconds - 4) < 0.12)
  assert.equal(structure.boxes.fastStart, true)

  const picture = await tool.execute({ action: 'picture', target: blackTail, probeFps: 2 }, { cwd: directory })
  assert.ok(picture.blackRuns.length >= 1)
  assert.equal(picture.probeFps, 2)

  await assert.rejects(() => tool.execute({ action: 'check', target: good, only: ['not_a_case'] }, { cwd: directory }), /未知的用例/)
  await assert.rejects(() => tool.execute({ action: 'check', target: join(directory, 'missing.mp4') }, { cwd: directory }), /找不到文件/)
})

test('strict turns a failed warning into a failure', async () => {
  const lenient = await runQc({ target: blackTail, config, ocr: false, only: ['black_frames'] })
  assert.equal(lenient.ok, true)
  assert.equal(lenient.counts.warned, 1)
  const strict = await runQc({ target: blackTail, config, ocr: false, only: ['black_frames'], strict: true })
  assert.equal(strict.ok, false)
  assert.equal(strict.counts.failed, 0, 'a warning stays a warning in the counts; strictness only decides ok')
})

test('a threshold override changes the verdict, and is echoed back', async () => {
  const lenient = await runQc({
    target: blackTail,
    config,
    ocr: false,
    only: ['black_frames'],
    thresholds: { maxBlackRunSeconds: 10 },
  })
  assert.equal(lenient.results[0].status, 'pass')
  assert.equal(lenient.thresholds.maxBlackRunSeconds, 10)
  assert.equal(lenient.thresholds.probeFps, QC_DEFAULTS.probeFps, 'untouched defaults are still reported')
})

test('a case file naming a case that does not exist is refused, not ignored', async () => {
  // A typo here would silently leave the check it meant to retune untouched, which is the one
  // failure mode a quality gate must not have.
  const actions = createQcActions(config, logger)
  const casesPath = join(directory, 'qc-typo.json')
  writeFileSync(casesPath, `${JSON.stringify({ cases: { black_frame: { enabled: false } } })}\n`, 'utf8')
  await assert.rejects(
    () => actions.check({ target: blackTail, casesPath, only: ['faststart'], ocr: false }, { cwd: directory }),
    /未知的用例 id/,
  )
})
