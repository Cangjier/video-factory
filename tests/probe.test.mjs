/**
 * Offline checks for media inspection helpers.
 *
 * The parsing cases are pinned here because ffprobe's output shape varies by
 * container and version, and a wrong duration or a missed rotation silently
 * mis-frames every scene that uses the file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { estimatedDuration, loadResolvedPlan } from '../src/core/plan.mjs'
import {
  IMAGE_EXTENSIONS,
  ProbeError,
  classify,
  isStill,
  parseRational,
  probe,
  probeMany,
  rotationOf,
  streamProblems,
} from '../src/core/probe.mjs'

const demoMaterial = 'examples/demo/material'
const demoOutput = 'examples/demo/out'

test('classify routes by extension, case-insensitively', () => {
  assert.equal(classify('a.JPG'), 'image')
  assert.equal(classify('a.jpeg'), 'image')
  assert.equal(classify('a.png'), 'image')
  assert.equal(classify('a.mp4'), 'video')
  assert.equal(classify('a.MOV'), 'video')
  assert.equal(classify('a.mp3'), 'audio')
  assert.equal(classify('a.wav'), 'audio')
  assert.equal(classify('a.psd'), 'unknown')
  assert.equal(classify('noextension'), 'unknown')
  assert.ok(IMAGE_EXTENSIONS.has('.heic'))
})

test('parseRational handles the forms ffprobe actually emits', () => {
  assert.equal(parseRational('30/1'), 30)
  assert.equal(parseRational('30000/1001'), 30000 / 1001)
  assert.equal(parseRational('25'), 25)
  // 0/0 is ffprobe's "unknown", not a division by zero.
  assert.equal(parseRational('0/0'), 0)
  assert.equal(parseRational(''), 0)
  assert.equal(parseRational(undefined), 0)
  assert.equal(parseRational('x/y'), 0)
})

test('rotationOf reads both the tag and the display matrix', () => {
  assert.equal(rotationOf({ tags: { rotate: '90' } }), 90)
  assert.equal(rotationOf({ tags: { rotate: '-90' } }), 270, 'negative angles normalize into [0,360)')
  assert.equal(rotationOf({ side_data_list: [{ rotation: -90 }] }), 270)
  assert.equal(rotationOf({}), 0)
  assert.equal(rotationOf(undefined), 0)
})

test('isStill treats a zero-duration video stream as a still', () => {
  assert.equal(isStill({ kind: 'image', hasVideo: true, duration: 0 }), true)
  assert.equal(isStill({ kind: 'video', hasVideo: true, duration: 0.04 }), true)
  assert.equal(isStill({ kind: 'video', hasVideo: true, duration: 3 }), false)
})

test('streamProblems reports what is unusable', () => {
  assert.deepEqual(streamProblems({ name: 'a.mp4', kind: 'video', hasVideo: true, width: 1920 }), [])
  assert.equal(streamProblems({ name: 'a.psd', kind: 'unknown', hasVideo: false, width: 0 }).length, 2)
  assert.ok(streamProblems({ name: 'a.mp4', kind: 'video', hasVideo: false, width: 0 })[0].includes('没有视频流'))
})

test('probe throws ProbeError for a missing file instead of a confusing ffprobe failure', async () => {
  await assert.rejects(() => probe('examples/definitely-not-here.mp4'), ProbeError)
})

test('probe reads a real still image from the demo material', async () => {
  // Any one of the demo stills; the point is that the real ffprobe path works.
  const { readdirSync } = await import('node:fs')
  const still = readdirSync(demoMaterial).find((name) => name.endsWith('.jpg'))
  assert.ok(still, 'the demo material should contain stills')

  const info = await probe(join(demoMaterial, still))
  assert.equal(info.kind, 'image')
  assert.ok(info.width > 0 && info.height > 0, 'a still must report its pixel dimensions')
  assert.ok(info.sizeBytes > 0)
  assert.equal(info.rotation, 0)
  assert.equal(info.hasVideo, true)
})

test('probe reads a real rendered video, including its audio track', async () => {
  const info = await probe(join(demoOutput, 'final.mp4'))
  assert.equal(info.kind, 'video')
  assert.equal(info.hasAudio, true, 'the demo render carries a music bed')
  assert.equal(info.width, 1080)
  assert.equal(info.height, 1920)
  assert.equal(info.pixFmt, 'yuv420p')
  assert.equal(info.videoCodec, 'h264')
  assert.equal(info.audioCodec, 'aac')
  assert.ok(info.bitRate > 0)
  assert.ok(info.sizeBytes > 100000)

  // The expected length comes from the plan that produced the file, not from a number
  // copied out of a previous run: hard-coding it makes this test fail whenever the demo
  // is re-rendered with a different plan, which says nothing about the probe.
  const plan = loadResolvedPlan(join(demoOutput, '..', 'plan.json'))
  const expected = estimatedDuration(plan.scenes)
  assert.ok(
    Math.abs(info.duration - expected) < 1,
    `expected roughly ${expected.toFixed(1)}s from the demo plan, got ${info.duration.toFixed(2)}s`,
  )
  assert.ok(Math.abs(info.fps - plan.fps) < 0.5, `expected ${plan.fps}fps, got ${info.fps}`)
})

test('probeMany reports unreadable files instead of failing the whole batch', async () => {
  const { items, skipped } = await probeMany([
    join(demoOutput, 'final.mp4'),
    'examples/definitely-not-here.mp4',
  ])
  assert.equal(items.length, 1)
  assert.equal(skipped.length, 1)
  assert.ok(skipped[0].path.endsWith('definitely-not-here.mp4'))
  assert.ok(skipped[0].reason.includes('文件不存在'))
})
