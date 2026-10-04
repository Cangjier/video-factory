/**
 * Offline checks for the proxy tunnel and the WebSocket transport that uses it.
 *
 * These exist because of a measured failure, not a hypothetical one: on a machine that reaches
 * the internet only through a system proxy, `video_narrate {action:"synthesize"}` failed with
 * `ECONNRESET` while every other networked action in the plugin worked. The installer had learned
 * to tunnel through the proxy; the read-aloud WebSocket still called `tls.connect` directly.
 *
 * The test that matters is the one with a local stand-in proxy: it asserts the CONNECT line that
 * actually arrives, so "we route through the proxy now" is evidence rather than intention. Nothing
 * here touches the public internet — the proxy is a loopback server that refuses on purpose, and
 * the target host never has to resolve.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { systemProxy, connectThroughProxy } from '../src/core/proxy.mjs'
import { systemProxy as systemProxyFromInstall } from '../src/core/install.mjs'
import { connect } from '../src/core/ws.mjs'

/** Run `body` with `HTTPS_PROXY` set to `value`, restoring the previous value afterwards. */
async function withProxyEnv(value, body) {
  const saved = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = value
  try {
    return await body()
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = saved
  }
}

// ---------------------------------------------------------------------------------------------
// Proxy resolution
// ---------------------------------------------------------------------------------------------

test('an explicit environment variable wins and is normalised to host:port', async () => {
  await withProxyEnv('http://127.0.0.1:7897/', () => {
    assert.equal(systemProxy(), '127.0.0.1:7897')
  })
})

test('a bare host:port is passed through unchanged', async () => {
  await withProxyEnv('127.0.0.1:1080', () => {
    assert.equal(systemProxy(), '127.0.0.1:1080')
  })
})

test('the proxy helpers are still exported from the installer module', () => {
  // The transport needs them and the installer needs them, so they moved to `proxy.mjs`. The
  // installer's surface is kept intact because it was published before the move.
  assert.equal(typeof systemProxyFromInstall, 'function')
  assert.equal(typeof connectThroughProxy, 'function')
  assert.equal(systemProxyFromInstall, systemProxy)
})

// ---------------------------------------------------------------------------------------------
// WebSocket transport
// ---------------------------------------------------------------------------------------------

test('connect refuses a non-wss scheme synchronously', () => {
  assert.throws(() => connect({ url: 'ws://example.test/socket' }), /only supports wss/)
})

test('a configured proxy receives a CONNECT for the websocket host, and its refusal is an error', async () => {
  const seen = []
  const server = net.createServer((connection) => {
    connection.once('data', (buffer) => {
      seen.push(buffer.toString('latin1').split('\r\n')[0])
      connection.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  try {
    await withProxyEnv(`127.0.0.1:${port}`, async () => {
      const socket = connect({ url: 'wss://example.test/socket?token=1', timeoutMs: 5000 })
      const outcome = await new Promise((resolve) => {
        socket.on('error', (error) => resolve(error))
        socket.on('open', () => resolve(new Error('the socket opened despite the proxy refusing')))
        setTimeout(() => resolve(new Error('neither error nor open arrived')), 8000)
      })
      socket.destroy()

      assert.equal(seen.length, 1, 'the proxy should have been asked exactly once')
      assert.equal(seen[0], 'CONNECT example.test:443 HTTP/1.1')
      assert.ok(outcome instanceof Error)
      assert.match(outcome.message, /502/)
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('a refused proxy surfaces on error instead of hanging', async () => {
  // Port 9 is the discard port; nothing listens, so the tunnel cannot be established. The point
  // is that the caller is released by an event rather than left waiting.
  await withProxyEnv('127.0.0.1:9', async () => {
    const socket = connect({ url: 'wss://example.test/socket', timeoutMs: 5000 })
    const outcome = await new Promise((resolve) => {
      socket.on('error', (error) => resolve(error))
      socket.on('open', () => resolve(new Error('the socket opened unexpectedly')))
      setTimeout(() => resolve(new Error('neither error nor open arrived')), 8000)
    })
    socket.destroy()
    assert.ok(outcome instanceof Error)
    assert.match(outcome.message, /127\.0\.0\.1:9/)
  })
})

test('send before the socket exists is a no-op rather than a crash', async () => {
  await withProxyEnv('127.0.0.1:9', async () => {
    const socket = connect({ url: 'wss://example.test/socket', timeoutMs: 5000 })
    assert.doesNotThrow(() => socket.send('hello'))
    assert.doesNotThrow(() => socket.close())
    socket.destroy()
    // let the tunnel failure land so the process is not left with a pending socket
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
})
