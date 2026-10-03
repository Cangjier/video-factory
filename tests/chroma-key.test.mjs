/**
 * Chroma key: the filter arithmetic, the guards, and the one end-to-end claim.
 *
 * The unit half is pure string construction, so it is tested without ffmpeg. The end-to-end half
 * renders a real green-screen plate and measures the result, because "the filter string looks
 * right" is not evidence that the background was actually replaced — the failure mode here is a
 * key that produces alpha which the pipeline then discards, leaving the original frame untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FilterError, chromaKeyComposite, chromaKeyFilter, chromaKeyValues } from '../src/core/filter.mjs'
import { resolveBinary } from '../src/core/env.mjs'

test('a green key despills green and a blue key despills blue', () => {
  assert.equal(chromaKeyFilter({ color: '#00B140' }), 'colorkey=0x00B140:0.3:0.1,despill=type=green')
  assert.equal(chromaKeyFilter({ color: '#0047BB' }), 'colorkey=0x0047BB:0.3:0.1,despill=type=blue')
})

test('spill can be turned off, and despill is accepted as the explicit name', () => {
  assert.equal(chromaKeyFilter({ color: '#00B140', spill: false }), 'colorkey=0x00B140:0.3:0.1')
  assert.equal(chromaKeyFilter({ color: '#00B140', despill: false }), 'colorkey=0x00B140:0.3:0.1')
  assert.equal(chromaKeyFilter({ color: '#00B140', spill: true }), 'colorkey=0x00B140:0.3:0.1,despill=type=green')
})

test('no key configured produces an empty fragment rather than a broken one', () => {
  assert.equal(chromaKeyFilter(undefined), '')
  assert.equal(chromaKeyFilter(null), '')
})

test('the resolved values are reported so a real frame can be used to tune them', () => {
  const values = chromaKeyValues({ color: '#00ff00', similarity: 0.42, blend: 0.08 })
  assert.equal(values.color, '0x00FF00')
  assert.equal(values.inputColor, '#00ff00')
  assert.equal(values.similarity, 0.42)
  assert.equal(values.blend, 0.08)
  assert.equal(values.spillType, 'green')
})

test('out-of-range and contradictory settings are refused with the field named', () => {
  assert.throws(() => chromaKeyValues({ similarity: 0 }), FilterError)
  assert.throws(() => chromaKeyValues({ similarity: 2 }), FilterError)
  assert.throws(() => chromaKeyValues({ blend: -0.1 }), FilterError)
  assert.throws(() => chromaKeyValues({ color: 'not-a-colour' }), FilterError)
  // similarity + blend is the whole distance range, so a sum above 1 has no meaning.
  assert.throws(() => chromaKeyValues({ similarity: 0.7, blend: 0.7 }), /must not exceed 1/)
  try {
    chromaKeyValues({ similarity: 5 })
    assert.fail('should have thrown')
  } catch (error) {
    assert.match(error.message, /chromaKey\.similarity/, 'the message must name the field')
  }
})

test('a composite needs a key and a background, and refuses anything else', () => {
  assert.equal(chromaKeyComposite(undefined, 640, 480, 30, 2), null)
  assert.equal(chromaKeyComposite({ color: '#00B140' }, 640, 480, 30, 2), null, 'no background means no composite')

  const composite = chromaKeyComposite({ color: '#00B140', background: '#203050' }, 640, 480, 30, 2)
  assert.ok(composite !== null)
  // The background input must be duration-bounded: a `lavfi` source is infinite by default, and
  // an infinite second input to `overlay` makes the graph emit frames forever. The picture was
  // capped by the output `-t` but the audio ran out, and the render died in the AAC encoder with
  // a message about NaN that said nothing about the real cause.
  assert.deepEqual(composite.input, [
    '-f', 'lavfi', '-t', '2.000', '-i', 'color=c=0x203050:s=640x480:r=30.000000',
  ])
  assert.match(composite.video, /\[0:v\]colorkey=0x00B140:0\.3:0\.1,despill=type=green,format=rgba\[ckfg\]/)
  // Key first, overlay second: overlaying an opaque frame would leave nothing to key against.
  assert.match(composite.video, /\[ckbg\]\[ckfg\]overlay=0:0:format=auto$/)
  assert.ok(
    composite.video.indexOf('[ckfg]') < composite.video.indexOf('overlay'),
    'the key must be built before the overlay consumes it',
  )
})

test('a composite demands a positive scene duration', () => {
  assert.throws(() => chromaKeyComposite({ color: '#00B140', background: '#203050' }, 640, 480, 30, 0), FilterError)
  assert.throws(() => chromaKeyComposite({ color: '#00B140', background: '#203050' }, 640, 480, 30, undefined), FilterError)
})

test('an image or video background is refused rather than silently treated as a colour', () => {
  assert.throws(() => chromaKeyComposite({ color: '#00B140', background: 'bg.jpg' }, 640, 480, 30, 2), FilterError)
  assert.throws(() => chromaKeyComposite({ color: '#00B140', background: '素材/bg.png' }, 640, 480, 30, 2), FilterError)
  try {
    chromaKeyComposite({ color: '#00B140', background: 'bg.jpg' }, 640, 480, 30, 2)
    assert.fail('should have thrown')
  } catch (error) {
    assert.match(error.message, /second input/, 'the message must say why it is unsupported')
  }
})

test('end to end: a green field over a solid background loses the green', () => {
  const ffmpeg = resolveBinary('ffmpeg', null)
  assert.ok(ffmpeg !== null, 'this test needs ffmpeg')

  const directory = mkdtempSync(join(tmpdir(), 'vf-chroma-'))
  try {
    // A pure green plate with an opaque non-green disc in the middle: the answer is known.
    const plate = join(directory, 'plate.png')
    const built = spawnSync(ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x00B140:s=160x120',
      '-f', 'lavfi', '-i', 'color=c=orange:s=60x60',
      '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2',
      '-frames:v', '1', '-update', '1', plate,
    ], { encoding: 'utf8' })
    assert.equal(built.status, 0, `could not build the plate: ${built.stderr}`)

    const out = join(directory, 'composited.png')
    const composite = chromaKeyComposite({ color: '#00B140', background: '#0000FF' }, 160, 120, 25, 1)
    const composed = spawnSync(ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'error', '-y',
      '-i', plate,
      ...composite.input,
      '-filter_complex', `${composite.video},format=rgb24[out]`,
      '-map', '[out]', '-frames:v', '1', '-update', '1', out,
    ], { encoding: 'utf8' })
    assert.equal(composed.status, 0, `composite failed: ${composed.stderr}`)

    /**
     * Average one channel over a region, using ffmpeg's own statistics so the measurement runs
     * through the same pipeline the renderer uses.
     * @param {string} region - a crop expression.
     * @param {string} channel - `r`, `g`, or `b`.
     * @returns {number} the mean value 0..255.
     */
    const meanOf = (region, channel) => {
      const measured = spawnSync(ffmpeg, [
        // `-v info`: the metadata filter logs through the logger, so `-v error` would silence
        // the measurement as well as the noise.
        '-hide_banner', '-nostdin', '-v', 'info',
        '-i', out,
        '-vf', `${region},extractplanes=${channel},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
        '-f', 'null', '-',
      ], { encoding: 'utf8' })
      const match = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(measured.stdout + measured.stderr)
      assert.ok(match !== null, `no measurement from ffmpeg: ${measured.stderr.slice(0, 400)}`)
      return Number(match[1])
    }

    // The border was green and the background is pure blue, so blue must now dominate there.
    const borderGreen = meanOf('crop=iw:6:0:2', 'g')
    const borderBlue = meanOf('crop=iw:6:0:2', 'b')
    assert.ok(borderBlue > 200, `the background should be blue at the border, got ${borderBlue}`)
    assert.ok(borderGreen < 80, `the green should be gone at the border, got ${borderGreen}`)

    // The disc was orange: red must survive, which is what proves the key did not eat the subject.
    const centreRed = meanOf('crop=40:40:(iw-40)/2:(ih-40)/2', 'r')
    assert.ok(centreRed > 200, `the subject should survive, got red ${centreRed}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
