/**
 * Offline checks for the material inventory.
 *
 * Perceptual hashing is the part most likely to be quietly wrong: a hash that never
 * matches reports no duplicates, and a hash that always matches reports everything as
 * a duplicate. Both are checked against real images from the demo folder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/core/ffmpeg.mjs'
import {
  DUPLICATE_DISTANCE,
  MaterialError,
  collectFiles,
  describe,
  differenceHash,
  hammingDistance,
  inventoryToJson,
  scan,
} from '../src/core/materials.mjs'

const demoMaterial = 'examples/demo/material'

/** Every still in the demo material folder, in a stable order. */
function demoStills() {
  return readdirSync(demoMaterial)
    .filter((name) => name.endsWith('.jpg'))
    .sort()
    .map((name) => join(demoMaterial, name))
}

test('hammingDistance counts differing bits', () => {
  assert.equal(hammingDistance(0n, 0n), 0)
  assert.equal(hammingDistance(0n, 1n), 1)
  assert.equal(hammingDistance(0b1011n, 0b0100n), 4)
  assert.equal(hammingDistance(0xffffffffffffffffn, 0n), 64)
})

test('collectFiles sorts by kind then name, so two runs agree', () => {
  const { files } = collectFiles(demoMaterial)
  const kinds = files.map((file) => (file.endsWith('.jpg') ? 'image' : 'audio'))
  // Every image comes before every audio file, and names within a kind are ordered.
  const firstAudio = kinds.indexOf('audio')
  assert.ok(firstAudio > 0)
  assert.ok(kinds.slice(firstAudio).every((kind) => kind === 'audio'))

  const again = collectFiles(demoMaterial).files
  assert.deepEqual(files, again, 'enumeration order must not leak into the result')
})

test('collectFiles rejects a missing root with a clear message', () => {
  assert.throws(() => collectFiles('examples/not-a-folder'), MaterialError)
})

test('differenceHash gives the same picture the same hash and different pictures different hashes', async () => {
  // The demo stills are synthetic vertical gradients. dHash compares each pixel with
  // its right neighbour, so a vertical gradient hashes identically no matter how the
  // colours differ — the same weakness the survey recorded for flat and gradient
  // artwork. They are therefore the wrong fixture for hash *discrimination*, even
  // though they are real files. Real footage is simulated here instead: one image
  // reused byte-for-byte, and one deliberately inverted.
  const folder = mkdtempSync(join(tmpdir(), 'vf-hash-'))
  const source = demoStills()[0]
  const original = readFileSync(source)
  const same = join(folder, 'same.jpg')
  const inverted = join(folder, 'inverted.jpg')
  writeFileSync(same, original)
  await run({
    tool: 'ffmpeg',
    args: ['-v', 'error', '-i', source, '-vf', 'negate', '-frames:v', '1', '-q:v', '2', inverted],
  })

  const a = await differenceHash(source)
  const b = await differenceHash(same)
  const c = await differenceHash(inverted)

  assert.notEqual(a, null)
  assert.notEqual(b, null)
  assert.notEqual(c, null)
  assert.equal(a, b, 'a byte-identical copy must hash identically')
  assert.ok(
    hammingDistance(a, c) > DUPLICATE_DISTANCE,
    `an inverted image must not read as a duplicate (distance ${hammingDistance(a, c)})`,
  )
})

test('differenceHash returns null rather than throwing on unreadable input', async () => {
  assert.equal(await differenceHash('examples/not-an-image.jpg'), null)
})

test('scan inventories the demo folder and marks duplicates without dropping them', async () => {
  const inventory = await scan(demoMaterial)

  assert.equal(inventory.counts.images, 6)
  assert.equal(inventory.counts.audio, 1)
  assert.equal(inventory.counts.videos, 0)
  assert.equal(inventory.images.length, 6, 'duplicates must still be listed')
  assert.equal(inventory.audio.length, 1)
  assert.equal(inventory.totalDuration, 0)

  for (const image of inventory.images) {
    assert.ok(image.width > 0 && image.height > 0)
    assert.ok(['portrait', 'landscape', 'square'].includes(image.orientation))
    assert.ok(image.hash !== null, 'every still should carry a hash when dedupe is on')
  }

  // Every recorded duplicate must point at another still in the same inventory.
  const paths = new Set(inventory.images.map((image) => image.path))
  for (const duplicate of inventory.duplicates) {
    assert.ok(duplicate.duplicateOf !== null)
    assert.ok(paths.has(duplicate.duplicateOf), 'duplicateOf must reference a listed still')
    assert.notEqual(duplicate.duplicateOf, duplicate.path, 'a still cannot duplicate itself')
  }
})

test('scan skips dedupe when asked and then reports no duplicates', async () => {
  const inventory = await scan(demoMaterial, { dedupe: false })
  assert.equal(inventory.duplicates.length, 0)
  assert.ok(inventory.images.every((image) => image.hash === null))
})

test('scan refuses an empty folder instead of reporting an empty inventory', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'vf-empty-'))
  await assert.rejects(() => scan(empty), MaterialError)
})

test('unreadable files land in skipped, not in the inventory', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'vf-skip-'))
  // A .png that is not a PNG at all, plus a file with an unsupported extension.
  writeFileSync(join(folder, 'broken.png'), 'this is not an image')
  writeFileSync(join(folder, 'notes.txt'), 'ignore me')
  writeFileSync(join(folder, 'Thumbs.db'), 'noise')

  const inventory = await scan(folder)
  // The broken png is a candidate by extension and must be reported as skipped with
  // a reason, not silently dropped and not counted as usable material.
  assert.equal(inventory.counts.total, 0)
  assert.equal(inventory.counts.skipped, 3)
  assert.ok(inventory.skipped.some((entry) => entry.path.endsWith('notes.txt')))
  assert.ok(inventory.skipped.some((entry) => entry.path.endsWith('Thumbs.db')))
  assert.ok(inventory.skipped.some((entry) => entry.path.endsWith('broken.png')))
})

test('inventoryToJson keeps the public fields and drops the internal hash', async () => {
  const inventory = await scan(demoMaterial)
  const json = inventoryToJson(inventory)
  assert.equal(json.counts.images, 6)
  assert.ok(json.images.length === 6)
  assert.ok(!('hash' in json.images[0]), 'the helper hash is an implementation detail')
  assert.ok('duplicateOf' in json.images[0], 'duplicate markers are part of the answer')
  assert.ok(json.root.length > 0)
  // It must survive JSON.stringify, since that is how a tool result is rendered.
  assert.doesNotThrow(() => JSON.stringify(json))
})

test('describe summarizes the inventory in one block', async () => {
  const inventory = await scan(demoMaterial)
  const text = describe(inventory)
  assert.ok(text.includes('图片 6 张'))
  assert.ok(text.includes('音频 1 个'))
})

test('DUPLICATE_DISTANCE stays strict enough to be meaningful', () => {
  // A threshold anywhere near half the bits would call unrelated photos duplicates.
  assert.ok(DUPLICATE_DISTANCE <= 10, 'the duplicate threshold must stay well below 32 bits')
})
