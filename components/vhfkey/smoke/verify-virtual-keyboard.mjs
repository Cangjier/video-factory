/**
 * Type through the virtual keyboard and read the document back verbatim.
 *
 * The client is a console application, so spawning it normally creates a console window that takes the
 * foreground away from the target — the keys then go somewhere else and the document stays empty. The first
 * verification appeared to work only because the keystrokes were sent before the window took focus.
 *
 * `windowsHide: true` suppresses the console window, and focus is re-asserted and *checked* immediately
 * before each send, so a failure is attributed to the right cause.
 *
 * The document is read back through the CLIPBOARD rather than through UI Automation, because two earlier
 * readings made a working keyboard look broken:
 *
 *   - UI Automation's Name property for the edit control strips LEADING whitespace, so a document holding one
 *     space reads as length 0. A lone space is the first thing this test types, so that stage always "failed"
 *     while the keystroke had in fact arrived.
 *   - The three stages type into ONE document, yet the verdict compared the whole document against the last
 *     stage's text alone, so it reported DIFFERENT no matter what had happened.
 *
 * The expected document is therefore the concatenation of what each stage types, and it is compared as such.
 * A single explicit `keyboard verdict:` line is printed for callers to read, so no caller has to pattern-match
 * a quoted string again.
 *
 * Selecting and copying is done with the virtual keyboard itself, which exercises the modifier chords too.
 * Ctrl+A leaves the whole document selected and the next keystroke would replace it, so END collapses the
 * selection back to the end before anything else is typed.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { desktop, windows } from '../../../src/core/automation.mjs'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..', '..', '..')
const client = resolve(root, 'components', 'vhfkey', 'out', 'vhfctl.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MARKER = 'VirtualKeyboard Works 12345'

let editor = null

/**
 * A value put on the clipboard before copying, because copying an EMPTY selection leaves the previous contents
 * in place. Without it an empty document reads as whatever was copied last — which is exactly what happened
 * when the baseline of this test came back holding text from an unrelated earlier run. If the marker is still
 * there after the copy, nothing was copied and the document really was empty.
 *
 * (An empty string cannot be used here: `Set-Clipboard -Value ""` fails on PowerShell 5.1, which binds it as
 * null and rejects it.)
 */
const CLIPBOARD_MARKER = '__video-factory-empty-document__'

const markClipboard = async () => {
  await run('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Set-Clipboard -Value '${CLIPBOARD_MARKER}'`],
    { encoding: 'buffer', timeout: 20_000 })
}

/** The clipboard, read raw: unlike an accessible name, it does not trim. */
const clipboardText = async () => {
  const { stdout } = await run('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()'],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 20_000 })
  return stdout.toString('utf8').replace(/\uFEFF/g, '')
}

/** Bring the editor forward and confirm it actually has focus before typing. */
const focusEditor = async () => {
  await desktop('focus', { X: editor.handle })
  await sleep(500)
  const front = await desktop('foreground')
  return Number(front.handle) === Number(editor.handle)
}

/** Run the client with no console window, so focus is not taken from the target. */
const send = async (args, settleMs = 1200) => {
  const focused = await focusEditor()
  const result = await run(client, args, { encoding: 'buffer', timeout: 60_000, windowsHide: true })
  await sleep(settleMs)
  return { focused, out: result.stdout.toString('utf8').trim(), code: result.code ?? 0 }
}

/**
 * Select all, copy, read the clipboard, then put the caret back at the end.
 *
 * The captured output carries the line terminator PowerShell appends to whatever it writes, so one trailing
 * CRLF is removed. It belongs to the harness, not to the document: the clipboard text is otherwise returned
 * exactly as it stands, which is the whole point of reading it this way.
 */
const readDocument = async () => {
  await markClipboard()
  await send(['combo', 'CTRL', 'A'], 700)
  await send(['combo', 'CTRL', 'C'], 900)
  const text = (await clipboardText()).replace(/\r\n$/, '')
  // Everything is selected at this point and the next keystroke would replace it, so the selection is
  // collapsed to the end of the document - which is where typing appends anyway.
  await send(['key', 'END'], 500)
  // The marker surviving the copy means nothing was copied, so the document really was empty.
  if (text === CLIPBOARD_MARKER) return ''
  return text
}

const hexOf = (text) =>
  text.split('').map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join(' ')

await run('cmd.exe', ['/c', 'start', '', 'notepad.exe'], { timeout: 10_000 }).catch(() => null)
await sleep(3500)
editor = (await windows()).find((entry) => entry.title.includes('记事本')) ?? null
if (editor === null) throw new Error('找不到记事本')
console.log(`notepad pid=${editor.pid}`)
await focusEditor()
// Start from a known-empty document. Notepad can reopen the previous session's unsaved text, and an empty
// start is what makes the expectations below exact rather than relative to whatever happened to be there.
await send(['combo', 'CTRL', 'A'], 500)
await send(['key', 'DELETE'], 800)
console.log(`baseline: ${JSON.stringify(await readDocument())}`)

const stages = [
  { label: 'one space, alone', args: ['key', 'SPACE'], appends: ' ' },
  { label: '"a b c"', args: ['type', 'a b c'], appends: 'a b c' },
  { label: 'the full marker', args: ['type', MARKER], appends: MARKER },
]

let expected = ''
let allMatched = true

for (const stage of stages) {
  console.log(`\n=== ${stage.label} ===`)
  const result = await send(stage.args)
  expected += stage.appends
  const received = await readDocument()
  const ok = received === expected
  if (!ok) allMatched = false
  console.log(`  focus before send: ${result.focused}  exit=${result.code}`)
  console.log(`  expected: LEN=${expected.length}  TEXT=[${expected}]`)
  console.log(`  received: LEN=${received.length}  TEXT=[${received}]`)
  console.log(`  HEX: ${hexOf(received)}`)
  console.log(`  ${ok ? 'MATCH' : 'DIFFERENT'}`)
}

console.log(`\nmarker:   ${JSON.stringify(MARKER)}`)
console.log(`document: ${JSON.stringify(expected)}`)
console.log(`keyboard verdict: ${allMatched ? 'WORKING' : 'DIFFERENT'}`)

/** A character-by-character difference, so a partial failure names the characters involved. */
if (!allMatched) {
  const received = await readDocument()
  const max = Math.max(expected.length, received.length)
  for (let i = 0; i < max; i++) {
    if (expected[i] !== received[i]) {
      console.log(`  first difference at index ${i}: expected ${JSON.stringify(expected[i])}, received ${JSON.stringify(received[i])}`)
      break
    }
  }
}

await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `Stop-Process -Id ${editor.pid} -Force -ErrorAction SilentlyContinue`], { timeout: 15_000 }).catch(() => null)
console.log('\nnotepad closed')
