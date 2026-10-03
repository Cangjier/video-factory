/**
 * Offline checks for image generation.
 *
 * Every network call is stubbed, deliberately: a real image request bills whether or not
 * it was meant to be a probe, and an earlier parameter sweep accidentally generated about
 * ten images before that was understood. The live round trip is exercised once, on demand,
 * by `tmp/smoke/ark-image-one.mjs` rather than by this suite.
 *
 * The response shape and the size limits asserted here were read off a real response.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArkError,
  DEFAULT_IMAGE_MODEL,
  IMAGE_MAX_PIXELS,
  IMAGE_MIN_PIXELS,
  generateImage,
} from '../src/core/ark.mjs'

/** A 1x1 PNG, so a download stub has real bytes to write. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Replace global fetch for the duration of a test, recording every call.
 * @param {(url: string, init: object) => {status: number, body: any, bytes?: Buffer}} handler -
 *   returns the canned response.
 * @returns {{calls: object[], restore: () => void}} the recorder and its undo.
 */
function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const result = handler(String(url), init)
    calls.push({ url: String(url), init })
    if (result.bytes !== undefined) {
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: async () => result.bytes,
      }
    }
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      headers: new Map(),
      text: async () => (typeof result.body === 'string' ? result.body : JSON.stringify(result.body)),
    }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('size limits match what the service reported', () => {
  // 512x512 was rejected ("at least 921600") and 8192x8192 was rejected ("at most 4624220").
  assert.equal(IMAGE_MIN_PIXELS, 921_600)
  assert.equal(IMAGE_MAX_PIXELS, 4_624_220)
  assert.ok(1024 * 1024 >= IMAGE_MIN_PIXELS, '1024x1024 must be legal')
  assert.ok(1920 * 1080 >= IMAGE_MIN_PIXELS && 1920 * 1080 <= IMAGE_MAX_PIXELS, '1080p must be legal')
  assert.ok(512 * 512 < IMAGE_MIN_PIXELS, '512x512 must be illegal')
  assert.ok(8192 * 8192 > IMAGE_MAX_PIXELS, '8192x8192 must be illegal')
})

test('generateImage refuses a missing prompt without touching the network', async () => {
  const stub = stubFetch(() => ({ status: 500, body: {} }))
  try {
    await assert.rejects(() => generateImage({}, { apiKey: 'k' }), /需要 spec\.prompt/)
    assert.equal(stub.calls.length, 0, 'a missing prompt must not reach the network')
  } finally {
    stub.restore()
  }
})

test('generateImage refuses a missing key without touching the network', async () => {
  const stub = stubFetch(() => ({ status: 500, body: {} }))
  try {
    await assert.rejects(() => generateImage({ prompt: 'x' }, {}), /缺少 apiKey/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('an out-of-range size is refused locally, before anything is billed', async () => {
  for (const size of ['512x512', '8192x8192', 'nonsense', '100x100']) {
    const stub = stubFetch(() => ({ status: 500, body: {} }))
    try {
      await assert.rejects(
        () => generateImage({ prompt: 'x', size }, { apiKey: 'k' }),
        ArkError,
        `${size} must be refused`,
      )
      assert.equal(stub.calls.length, 0, `${size} must not reach the network`)
    } finally {
      stub.restore()
    }
  }
})

test('a legal size is accepted and sent as-is', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return { status: 200, body: { model: DEFAULT_IMAGE_MODEL, data: [{ url: 'https://example.test/a.jpg', size: '1024x1024', output_format: 'jpeg' }], usage: { generated_images: 1 } } }
    }
    return { status: 200, bytes: PNG_BYTES }
  })
  try {
    const result = await generateImage(
      { prompt: 'a cat', size: '1024x1024' },
      { apiKey: 'k', outDir: directory, fileName: 'shot' },
    )
    const request = JSON.parse(stub.calls[0].init.body)
    assert.equal(request.size, '1024x1024')
    assert.equal(request.prompt, 'a cat')
    assert.equal(stub.calls.length, 2, 'one request plus one download')
    // The name has no extension, so the provider's reported format supplies it.
    assert.ok(result.localPath.endsWith('shot.jpg'), `got ${result.localPath}`)
    assert.equal(result.size, '1024x1024')
    assert.ok(statSync(result.localPath).size > 0)
  } finally {
    stub.restore()
  }
})

test('only explicitly supplied optional fields reach the request body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return { status: 200, body: { data: [{ url: 'https://example.test/a.jpg', output_format: 'png' }] } }
    }
    return { status: 200, bytes: PNG_BYTES }
  })
  try {
    await generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory })
    const body = JSON.parse(stub.calls[0].init.body)
    // `watermark` and `seed` were not asked for, so they must be absent rather than
    // defaulted: a silent default changes the picture and the bill.
    assert.deepEqual(Object.keys(body).sort(), ['model', 'prompt'])
  } finally {
    stub.restore()
  }
})

test('watermark and seed are forwarded when the caller does supply them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return { status: 200, body: { data: [{ url: 'https://example.test/a.jpg', output_format: 'jpeg' }] } }
    }
    return { status: 200, bytes: PNG_BYTES }
  })
  try {
    await generateImage({ prompt: 'x', watermark: false, seed: 42 }, { apiKey: 'k', outDir: directory })
    const body = JSON.parse(stub.calls[0].init.body)
    assert.equal(body.watermark, false)
    assert.equal(body.seed, 42)
  } finally {
    stub.restore()
  }
})

test('the file extension follows what the provider actually returned', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return { status: 200, body: { data: [{ url: 'https://example.test/a', output_format: 'png' }] } }
    }
    return { status: 200, bytes: PNG_BYTES }
  })
  try {
    // No fileName given, so the default name is built from the reported format.
    const result = await generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory })
    assert.ok(result.localPath.endsWith('.png'), `expected a .png, got ${result.localPath}`)
  } finally {
    stub.restore()
  }
})

test('a caller extension that contradicts the content is corrected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      // The provider says jpeg while the caller asked for a .png name. Trusting the
      // caller produced a PNG-named file holding JPEG bytes, which misleads the material
      // scanner, whose classify() branches on the extension.
      return { status: 200, body: { data: [{ url: 'https://example.test/a', output_format: 'jpeg' }] } }
    }
    return { status: 200, bytes: PNG_BYTES }
  })
  try {
    const result = await generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory, fileName: 'cover.png' })
    assert.ok(result.localPath.endsWith('cover.jpg'), `expected cover.jpg, got ${result.localPath}`)
    assert.ok(!result.localPath.includes('.png'), 'the wrong extension must be replaced, not appended to')
  } finally {
    stub.restore()
  }
})

test('a matching caller extension is left alone', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return { status: 200, body: { data: [{ url: 'https://example.test/a', output_format: 'jpeg' }] } }
    }
    return { status: 200, bytes: PNG_BYTES }
  })
  try {
    // `.jpg` and `jpeg` are the same format and must not be rewritten.
    const result = await generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory, fileName: 'shot.jpg' })
    assert.ok(result.localPath.endsWith('shot.jpg'), `got ${result.localPath}`)
  } finally {
    stub.restore()
  }
})

test('an inline b64_json response is written without a second request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch(() => ({
    status: 200,
    body: { data: [{ b64_json: PNG_BYTES.toString('base64'), output_format: 'png' }] },
  }))
  try {
    const result = await generateImage({ prompt: 'x', responseFormat: 'b64_json' }, { apiKey: 'k', outDir: directory })
    assert.equal(stub.calls.length, 1, 'inline bytes need no download request')
    assert.ok(readFileSync(result.localPath).equals(PNG_BYTES))
  } finally {
    stub.restore()
  }
})

test('a response with neither url nor b64_json is reported, not written as an empty file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch(() => ({ status: 200, body: { data: [{ size: '1024x1024' }] } }))
  try {
    await assert.rejects(
      () => generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory }),
      /既没有 url 也没有 b64_json/,
    )
  } finally {
    stub.restore()
  }
})

test('an empty data array is reported rather than crashing on a missing index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch(() => ({ status: 200, body: { data: [] } }))
  try {
    await assert.rejects(() => generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory }), /没有 data\[0\]/)
  } finally {
    stub.restore()
  }
})

test('a failed download is reported with the expiry caveat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vf-img-'))
  const stub = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return { status: 200, body: { data: [{ url: 'https://example.test/gone.jpg', output_format: 'jpeg' }] } }
    }
    return { status: 403, body: '' }
  })
  try {
    await assert.rejects(
      () => generateImage({ prompt: 'x' }, { apiKey: 'k', outDir: directory }),
      /24 小时过期/,
      'a download failure must explain that the link expires',
    )
  } finally {
    stub.restore()
  }
})
