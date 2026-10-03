/**
 * Type through the virtual keyboard without letting the client steal focus.
 *
 * The client is a console application, so spawning it normally creates a console window that takes the
 * foreground away from the target — the keys then go somewhere else and the document stays empty. The first
 * verification appeared to work only because the keystrokes were sent before the window took focus.
 *
 * `windowsHide: true` suppresses the console window, and focus is re-asserted and *checked* immediately
 * before each send, so a failure is attributed to the right cause.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { desktop, windows } from '../../../src/core/automation.mjs'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..', '..', '..')
const client = resolve(root, 'components', 'vhfkey', 'out', 'vhfctl.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let editor = null

const readHex = async () => {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${editor.pid})
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($null -eq $win) { Write-Output 'NOWINDOW'; exit 0 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$node = $walker.GetFirstChild($win)
while ($node) {
  if ($node.Current.AutomationId -eq '15') {
    $text = $node.Current.Name
    Write-Output ("LEN=" + $text.Length)
    Write-Output ("TEXT=[" + $text + "]")
    $codes = $text.ToCharArray() | ForEach-Object { [int]$_ }
    Write-Output ("HEX=" + (($codes | ForEach-Object { $_.ToString('X2') }) -join ' '))
  }
  $node = $walker.GetNextSibling($node)
}
`
  const { stdout } = await run('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 20_000 })
  return stdout.toString('utf8').replace(/\uFEFF/g, '').trim()
}

/** Bring the editor forward and confirm it actually has focus before typing. */
const focusEditor = async () => {
  await desktop('focus', { X: editor.handle })
  await sleep(500)
  const front = await desktop('foreground')
  return Number(front.handle) === Number(editor.handle)
}

/** Run the client with no console window, so focus is not taken from the target. */
const send = async (args) => {
  const focused = await focusEditor()
  const result = await run(client, args, { encoding: 'buffer', timeout: 60_000, windowsHide: true })
  await sleep(1200)
  return { focused, out: result.stdout.toString('utf8').trim(), code: result.code ?? 0 }
}

await run('cmd.exe', ['/c', 'start', '', 'notepad.exe'], { timeout: 10_000 }).catch(() => null)
await sleep(3500)
editor = (await windows()).find((entry) => entry.title.includes('记事本')) ?? null
if (editor === null) throw new Error('找不到记事本')
console.log(`notepad pid=${editor.pid}`)
await focusEditor()
console.log(`baseline:\n${await readHex()}`)

console.log('\n=== one space, alone ===')
let r = await send(['key', 'SPACE'])
console.log(`  focus before send: ${r.focused}  exit=${r.code}`)
console.log(await readHex())

console.log('\n=== "a b c" ===')
r = await send(['type', 'a b c'])
console.log(`  focus before send: ${r.focused}  exit=${r.code}`)
console.log(await readHex())

console.log('\n=== the full marker ===')
const marker = 'VirtualKeyboard Works 12345'
r = await send(['type', marker])
console.log(`  focus before send: ${r.focused}  exit=${r.code}`)
const after = await readHex()
console.log(after)

// Compare on the text line only, which is what the read-back labels.
const received = (/TEXT=\[(.*)\]/s.exec(after)?.[1]) ?? ''
console.log(`\nsent:     ${JSON.stringify(marker)}`)
console.log(`received: ${JSON.stringify(received)}`)
console.log(`result:   ${received === marker ? 'MATCH' : 'DIFFERENT'}`)

/** A character-by-character difference, so a partial failure names the characters involved. */
if (received !== marker) {
  const max = Math.max(marker.length, received.length)
  for (let i = 0; i < max; i++) {
    if (marker[i] !== received[i]) {
      console.log(`  first difference at index ${i}: sent ${JSON.stringify(marker[i])}, received ${JSON.stringify(received[i])}`)
      break
    }
  }
}

await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', `Stop-Process -Id ${editor.pid} -Force -ErrorAction SilentlyContinue`], { timeout: 15_000 }).catch(() => null)
console.log('\nnotepad closed')
