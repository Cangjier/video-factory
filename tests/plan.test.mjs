/**
 * Offline checks for plan.json validation and timeline arithmetic.
 *
 * Validation is the contract DSH relies on, so the interesting cases are the
 * rejections: each one must name the field that is wrong, because that message is
 * what the model reads to fix its plan.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PLAN_VERSION,
  PlanError,
  effectiveOverlap,
  estimatedDuration,
  fieldReference,
  missingFiles,
  parsePlan,
  resolvePlanPaths,
  transitionOffsets,
} from '../src/core/plan.mjs'

const baseDir = 'C:/work'

/** A minimal valid scene, overridable per test. */
const scene = (extra = {}) => ({ kind: 'image', source: 'a.jpg', duration: 3, ...extra })

/** A minimal valid plan document, overridable per test. */
const doc = (extra = {}) => ({ version: 1, scenes: [scene()], ...extra })

test('a minimal plan gets exactly the documented defaults', () => {
  const plan = parsePlan(doc(), baseDir)
  assert.equal(plan.version, PLAN_VERSION)
  assert.equal(plan.preset, 'custom')
  // No preset means the fallback canvas, not a preset's canvas.
  assert.equal(plan.width, 1080)
  assert.equal(plan.height, 1920)
  assert.equal(plan.fps, 30)
  assert.equal(plan.quality, 'high')
  assert.equal(plan.title, '')

  const parsed = plan.scenes[0]
  assert.equal(parsed.id, 's01', 'the first scene is named s01')
  assert.equal(parsed.fit, 'cover')
  assert.equal(parsed.motion, 'none')
  assert.equal(parsed.speed, 1)
  assert.equal(parsed.volume, 1)
  assert.equal(parsed.muted, false)
  assert.deepEqual(parsed.transition, { type: 'none', duration: 0.5 })
  assert.deepEqual(parsed.overlays, [])
  assert.equal(parsed.generate, null)
  assert.equal(parsed.resolved, null)

  assert.equal(plan.audio.musicGainDb, -18)
  assert.equal(plan.audio.duck, true)
  assert.equal(plan.audio.fadeOut, 1.5)
  assert.equal(plan.audio.loudnessTarget, -14)
  assert.equal(plan.audio.keepSceneAudio, true)
  assert.equal(plan.subtitles.enabled, false)
  assert.equal(plan.subtitles.burn, true)
  assert.equal(plan.subtitles.fontSize, 44)
  assert.equal(plan.subtitles.marginV, 200)
})

test('a preset supplies the canvas but explicit values still win', () => {
  const plan = parsePlan(doc({ meta: { preset: 'square' } }), baseDir)
  assert.equal(plan.width, 1080)
  assert.equal(plan.height, 1080)
  assert.equal(plan.preset, 'square')

  const overridden = parsePlan(doc({ meta: { preset: 'square', width: 720, fps: 24 } }), baseDir)
  assert.equal(overridden.width, 720)
  assert.equal(overridden.height, 1080, 'unspecified height still comes from the preset')
  assert.equal(overridden.fps, 24)
})

test('scene ids default to a stable sNN sequence and must be unique', () => {
  const plan = parsePlan(doc({ scenes: [scene(), scene(), scene()] }), baseDir)
  assert.deepEqual(plan.scenes.map((s) => s.id), ['s01', 's02', 's03'])

  assert.throws(
    () => parsePlan(doc({ scenes: [scene({ id: 'x' }), scene({ id: 'x' })] }), baseDir),
    /duplicate scene id 'x'/,
  )
})

test('every rejection names the offending field', () => {
  const cases = [
    [doc({ version: 2 }), /Unsupported plan version 2/],
    [doc({ meta: { preset: 'cinema' } }), /meta\.preset: unknown preset 'cinema'/],
    [doc({ meta: { width: 10 } }), /meta\.width: 10 is below the minimum 64/],
    [doc({ meta: { fps: 0 } }), /meta\.fps: 0 is below the minimum 1/],
    [doc({ meta: { quality: 'best' } }), /meta\.quality: unknown quality 'best'/],
    [doc({ scenes: [] }), /scenes: the plan must contain at least one scene/],
    [doc({ scenes: 'nope' }), /scenes: the plan must contain at least one scene/],
    [{ version: 1 }, /scenes: the plan must contain at least one scene/],
    [doc({ scenes: [scene({ kind: 'gif' })] }), /scenes\[0\]\.kind: unknown kind 'gif'/],
    [doc({ scenes: [scene({ motion: 'spin' })] }), /scenes\[0\]\.motion: unknown motion 'spin'/],
    [doc({ scenes: [scene({ fit: 'stretch' })] }), /scenes\[0\]\.fit: unknown fit 'stretch'/],
    [doc({ scenes: [scene({ duration: 0.1 })] }), /scenes\[0\]\.duration: 0\.1 is below the minimum 0\.2/],
    [doc({ scenes: [scene({ duration: 601 })] }), /scenes\[0\]\.duration: 601 is above the maximum 600/],
    [doc({ scenes: [scene({ speed: 0 })] }), /scenes\[0\]\.speed: 0 is below the minimum 0\.1/],
    [doc({ scenes: [scene({ transition: { type: 'melt' } })] }), /scenes\[0\]\.transition\.type: unknown transition 'melt'/],
    [doc({ scenes: [scene({ overlays: 'x' })] }), /scenes\[0\]\.overlays: expected an array/],
    [doc({ scenes: [scene({ overlays: [{}] })] }), /scenes\[0\]\.overlays\[0\]: missing required field 'text'/],
    [doc({ scenes: [{ kind: 'image' }] }), /scenes\[0\]: needs 'source', 'color', or 'generate'/],
    [doc({ audio: { music_gain_db: 99 } }), /audio\.music_gain_db: 99 is above the maximum 12/],
    [doc({ subtitles: { font_size: 4 } }), /subtitles\.font_size: 4 is below the minimum 8/],
  ]
  for (const [document, pattern] of cases) {
    assert.throws(() => parsePlan(document, baseDir), pattern, `expected ${pattern}`)
  }
})

test('a boolean is never accepted as a number', () => {
  // `true` would otherwise coerce to 1 and turn a typo into a one-second scene.
  assert.throws(() => parsePlan(doc({ scenes: [scene({ duration: true })] }), baseDir), /expected a number/)
  assert.throws(() => parsePlan(doc({ meta: { fps: true } }), baseDir), /expected a number/)
})

test('a colour scene needs no source', () => {
  const plan = parsePlan(doc({ scenes: [{ kind: 'color', color: '#112233', duration: 2 }] }), baseDir)
  assert.equal(plan.scenes[0].kind, 'color')
  assert.equal(plan.scenes[0].source, null)
})

test('a generate block makes the scene kind "generated" by default', () => {
  const plan = parsePlan(
    doc({ scenes: [{ duration: 5, generate: { prompt: 'a cat' } }] }),
    baseDir,
  )
  const parsed = plan.scenes[0]
  assert.equal(parsed.kind, 'generated')
  assert.equal(parsed.generate.provider, 'ark')
  assert.equal(parsed.generate.mode, 'text-to-video')
  assert.equal(parsed.generate.duration, 5)
  assert.equal(parsed.generate.resolution, '720p')
  assert.equal(parsed.generate.seed, -1)
  assert.equal(parsed.generate.watermark, true)
  assert.equal(parsed.generate.serviceTier, null, 'service_tier must default to null, not a string')
})

test('generate rejects an unknown mode and a missing prompt', () => {
  assert.throws(
    () => parsePlan(doc({ scenes: [{ generate: { prompt: 'x', mode: 'morph' } }] }), baseDir),
    /scenes\[0\]\.generate\.mode: expected text-to-video/,
  )
  assert.throws(
    () => parsePlan(doc({ scenes: [{ generate: { mode: 'text-to-video' } }] }), baseDir),
    /scenes\[0\]\.generate: missing required field 'prompt'/,
  )
})

test('estimatedDuration subtracts only the effective overlap', () => {
  const scenes = parsePlan(
    doc({
      scenes: [
        scene({ duration: 3 }),
        scene({ duration: 3, transition: { type: 'fade', duration: 0.5 } }),
        scene({ duration: 3, transition: { type: 'fade', duration: 0.5 } }),
      ],
    }),
    baseDir,
  ).scenes
  // 9s of scenes minus two 0.5s overlaps.
  assert.equal(estimatedDuration(scenes), 8)
  assert.equal(effectiveOverlap(scenes, 1), 0.5)
  assert.equal(transitionOffsets(scenes).length, 2)
})

test('a transition never consumes more than half of either neighbour', () => {
  const scenes = parsePlan(
    doc({
      scenes: [
        scene({ duration: 1 }),
        scene({ duration: 1, transition: { type: 'fade', duration: 5 } }),
      ],
    }),
    baseDir,
  ).scenes
  // min(5, 1*0.5, 1*0.5) = 0.5
  assert.equal(effectiveOverlap(scenes, 1), 0.5)
  assert.equal(estimatedDuration(scenes), 1.5)
})

test('a hard cut produces an offset of -1, not 0', () => {
  const scenes = parsePlan(doc({ scenes: [scene({ duration: 3 }), scene({ duration: 3 })] }), baseDir).scenes
  assert.deepEqual(transitionOffsets(scenes), [-1], 'without a transition the boundary must be a hard cut')
  assert.equal(effectiveOverlap(scenes, 1), 0)
  assert.equal(estimatedDuration(scenes), 6)
})

test('resolvePlanPaths makes relative paths absolute and leaves absolute ones alone', () => {
  const plan = parsePlan(
    doc({
      scenes: [scene({ source: 'material/a.jpg' }), scene({ source: 'C:/abs/b.jpg' })],
      audio: { music: 'bgm.mp3' },
      subtitles: { enabled: true, source: 'subs.srt' },
    }),
    'C:/work',
  )
  resolvePlanPaths(plan)
  assert.equal(plan.scenes[0].resolved, 'C:\\work\\material\\a.jpg')
  assert.equal(plan.scenes[1].resolved, 'C:\\abs\\b.jpg')
  assert.equal(plan.audio.music, 'C:\\work\\bgm.mp3')
  assert.equal(plan.subtitles.source, 'C:\\work\\subs.srt')
})

test('subtitles.source "auto" is a keyword, not a path', () => {
  const plan = parsePlan(doc({ subtitles: { enabled: true, source: 'auto' } }), baseDir)
  resolvePlanPaths(plan)
  assert.equal(plan.subtitles.source, 'auto')
})

test('a generated scene with no source keeps resolved null', () => {
  const plan = parsePlan(doc({ scenes: [{ generate: { prompt: 'x' }, duration: 5 }] }), baseDir)
  resolvePlanPaths(plan)
  assert.equal(plan.scenes[0].resolved, null)
})

test('missingFiles reports every absent reference and nothing else', () => {
  const plan = parsePlan(
    doc({
      scenes: [scene({ source: 'have.jpg' }), scene({ source: 'gone.jpg' })],
      audio: { music: 'gone.mp3' },
    }),
    baseDir,
  )
  resolvePlanPaths(plan)
  const problems = missingFiles(plan, (path) => path.endsWith('have.jpg'))
  assert.equal(problems.length, 2)
  assert.ok(problems.some((message) => message.includes('scenes[s02].source')))
  assert.ok(problems.some((message) => message.includes('audio.music')))
})

test('the field reference is packaged and mentions the verified Ark constraints', () => {
  const reference = fieldReference()
  assert.ok(reference.includes('plan.json'))
  assert.ok(reference.includes('service_tier'), 'the reference must document the field 2.0 rejects')
  assert.ok(reference.includes('4–15'), 'the reference must carry the verified Seedance 2.0 duration range')
})
