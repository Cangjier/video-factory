/**
 * Offline checks for the keyboard transport layer.
 *
 * The transport preferences and the chord decoding are pure and are tested here without a desktop. They
 * earn tests for the same reason the coordinate arithmetic does: a wrong answer is not an error, it is a
 * plausible-looking request sent to the wrong place.
 *
 * The preference order encodes measurements rather than taste — the virtual keyboard works, the filter
 * driver's keyboard path silently delivers nothing on this machine, SendInput always works — so the order
 * is asserted rather than left to drift.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INPUT_TRANSPORTS, TRANSPORT_PREFERENCE, decodeKeyChord } from '../src/core/automation.mjs'

// ---------------------------------------------------------------------------------------------
// Transport preference
// ---------------------------------------------------------------------------------------------

test('every preferred transport is a known transport', () => {
  for (const [kind, order] of Object.entries(TRANSPORT_PREFERENCE)) {
    for (const transport of order) {
      assert.ok(
        INPUT_TRANSPORTS.includes(transport),
        `${kind} prefers "${transport}", which is not in INPUT_TRANSPORTS`,
      )
    }
  }
})

test('keyboard prefers the virtual HID keyboard', () => {
  // It is a real device, so nothing above the HID layer can treat its input as synthetic. That is the
  // whole reason it exists, so it must be first.
  assert.equal(TRANSPORT_PREFERENCE.keyboard[0], 'virtualkbd')
})

test('keyboard ranks the filter driver last', () => {
  // Measured: it reports every keystroke as accepted and none arrives. It stays in the list for machines
  // where it does work, but it must never be preferred over a transport known to function.
  const order = TRANSPORT_PREFERENCE.keyboard
  assert.equal(order[order.length - 1], 'driver')
  assert.ok(order.indexOf('sendinput') < order.indexOf('driver'))
})

test('mouse prefers the virtual HID mouse', () => {
  // It is a real HID device with absolute positioning, measured accurate to within a pixel, so nothing above
  // the HID layer can treat its input as synthetic. The filter driver follows, then SendInput.
  assert.equal(TRANSPORT_PREFERENCE.mouse[0], 'virtualmouse')
  assert.deepEqual(TRANSPORT_PREFERENCE.mouse, ['virtualmouse', 'driver', 'sendinput'])
})

test('the keyboard and mouse preferences never name each other device', () => {
  // A keyboard report delivered to the mouse device would be read as a pointer movement, and the reverse as a
  // keystroke. The two lists are separate, and this keeps them that way.
  assert.ok(!TRANSPORT_PREFERENCE.keyboard.includes('virtualmouse'))
  assert.ok(!TRANSPORT_PREFERENCE.mouse.includes('virtualkbd'))
})

// ---------------------------------------------------------------------------------------------
// Chord decoding
// ---------------------------------------------------------------------------------------------

test('a plain key name decodes to itself with no modifier', () => {
  assert.deepEqual(decodeKeyChord('A'), { modifier: null, key: 'A' })
  assert.deepEqual(decodeKeyChord('{ENTER}'), { modifier: null, key: 'ENTER' })
})

test('the SendKeys modifier prefixes become named modifiers', () => {
  assert.deepEqual(decodeKeyChord('^c'), { modifier: 'CTRL', key: 'C' })
  assert.deepEqual(decodeKeyChord('%{F4}'), { modifier: 'ALT', key: 'F4' })
  assert.deepEqual(decodeKeyChord('+{TAB}'), { modifier: 'SHIFT', key: 'TAB' })
})

test('SendKeys names are translated to the names the device understands', () => {
  // The HID usage table calls these ENTER, ESC, DELETE, INSERT and BACKSPACE; SendKeys calls them RETURN,
  // ESCAPE, DEL, INS and BACK. Passing the SendKeys spelling straight through would send nothing.
  assert.deepEqual(decodeKeyChord('{RETURN}'), { modifier: null, key: 'ENTER' })
  assert.deepEqual(decodeKeyChord('{ESCAPE}'), { modifier: null, key: 'ESC' })
  assert.deepEqual(decodeKeyChord('{DEL}'), { modifier: null, key: 'DELETE' })
  assert.deepEqual(decodeKeyChord('{INS}'), { modifier: null, key: 'INSERT' })
  assert.deepEqual(decodeKeyChord('{BACK}'), { modifier: null, key: 'BACKSPACE' })
})

test('braced names are matched case-insensitively', () => {
  assert.deepEqual(decodeKeyChord('{enter}'), { modifier: null, key: 'ENTER' })
  assert.deepEqual(decodeKeyChord('{F12}'), { modifier: null, key: 'F12' })
})

test('a bare letter with a modifier is upper-cased', () => {
  // The device takes a key name, and the shift state is carried by the modifier rather than the case.
  assert.deepEqual(decodeKeyChord('^a'), { modifier: 'CTRL', key: 'A' })
})

test('anything that is not a chord returns null so the caller passes it through untouched', () => {
  // Null is the signal to hand the original string to SendInput rather than guessing at the grammar.
  // Guessing wrongly would be worse than not understanding it.
  assert.equal(decodeKeyChord('hello'), null)
  assert.equal(decodeKeyChord(''), null)
  assert.equal(decodeKeyChord(null), null)
  assert.equal(decodeKeyChord(undefined), null)
  assert.equal(decodeKeyChord('{UNCLOSED'), null)
})

test('a single character with no modifier still decodes', () => {
  assert.deepEqual(decodeKeyChord('a'), { modifier: null, key: 'A' })
})
