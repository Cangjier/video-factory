/**
 * Offline checks for the coordinate arithmetic the vision layer depends on.
 *
 * These functions are pure, so they are tested without touching a desktop. They earn tests because
 * a wrong conversion is invisible at runtime: the click is delivered, the application receives it,
 * and it simply lands somewhere else. That failure mode has already cost this project several
 * rounds, and both bugs that caused it were arithmetic rather than anything to do with input.
 *
 * The reference values are the ones measured on the live desktop, so the tests encode what was
 * actually observed rather than what the code happens to compute.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTENT_OFFSET, clientToScreen, screenToClient } from '../src/core/automation.mjs'

// Measured on this machine: a browser placed at (40,30) whose page reported a click at client
// (132,54) had been clicked at screen (183,164).
const WINDOW_ORIGIN = { x: 40, y: 30 }
const OBSERVED_CLIENT = { x: 132, y: 54 }
const OBSERVED_SCREEN = { x: 183, y: 164 }

test('client converts to the screen coordinate that was actually observed', () => {
  const screen = clientToScreen(WINDOW_ORIGIN, OBSERVED_CLIENT)
  assert.deepEqual(screen, OBSERVED_SCREEN)
})

test('the conversion round-trips', () => {
  for (const client of [{ x: 0, y: 0 }, OBSERVED_CLIENT, { x: 900, y: 700 }]) {
    const screen = clientToScreen(WINDOW_ORIGIN, client)
    assert.deepEqual(screenToClient(WINDOW_ORIGIN, screen), client)
  }
})

test('the window position is applied exactly once', () => {
  // The bug this guards against is adding the window origin twice, which aims every click one
  // window-origin too far down and to the right while still producing a plausible number.
  const screen = clientToScreen(WINDOW_ORIGIN, OBSERVED_CLIENT)
  const doubled = {
    x: WINDOW_ORIGIN.x * 2 + CONTENT_OFFSET.x + OBSERVED_CLIENT.x,
    y: WINDOW_ORIGIN.y * 2 + CONTENT_OFFSET.y + OBSERVED_CLIENT.y,
  }
  assert.notDeepEqual(screen, doubled, 'the origin must not be counted twice')
  assert.equal(screen.x, WINDOW_ORIGIN.x + CONTENT_OFFSET.x + OBSERVED_CLIENT.x)
  assert.equal(screen.y, WINDOW_ORIGIN.y + CONTENT_OFFSET.y + OBSERVED_CLIENT.y)
})

test('a zero offset makes client and screen equivalent up to the window position', () => {
  const zero = { x: 0, y: 0 }
  const screen = clientToScreen(WINDOW_ORIGIN, OBSERVED_CLIENT, zero)
  assert.deepEqual(screen, {
    x: WINDOW_ORIGIN.x + OBSERVED_CLIENT.x,
    y: WINDOW_ORIGIN.y + OBSERVED_CLIENT.y,
  })
})

test('an explicit offset overrides the default', () => {
  // Chrome height varies with what the browser shows, so callers must be able to supply a measured
  // offset. A supplied value silently ignored would reintroduce the same mis-aim.
  const measured = { x: 8, y: 120 }
  const screen = clientToScreen(WINDOW_ORIGIN, OBSERVED_CLIENT, measured)
  assert.deepEqual(screen, {
    x: WINDOW_ORIGIN.x + measured.x + OBSERVED_CLIENT.x,
    y: WINDOW_ORIGIN.y + measured.y + OBSERVED_CLIENT.y,
  })
  assert.notDeepEqual(screen, clientToScreen(WINDOW_ORIGIN, OBSERVED_CLIENT, CONTENT_OFFSET))
})

test('screenToClient is the exact inverse of clientToScreen', () => {
  const screen = { x: 500, y: 400 }
  const client = screenToClient(WINDOW_ORIGIN, screen)
  assert.deepEqual(clientToScreen(WINDOW_ORIGIN, client), screen)
})

test('the default offset matches the measured chrome, not zero', () => {
  // A zero offset would mean the content area starts at the window's top-left, which is false for
  // any window with a title bar. The measured chrome height dominates the vertical component.
  assert.ok(CONTENT_OFFSET.y > 40, `expected a chrome-sized vertical offset, got ${CONTENT_OFFSET.y}`)
  assert.ok(CONTENT_OFFSET.x >= 0 && CONTENT_OFFSET.x < 40, `expected a small border offset, got ${CONTENT_OFFSET.x}`)
})
