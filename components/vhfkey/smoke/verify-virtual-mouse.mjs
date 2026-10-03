/**
 * Verify the virtual mouse: absolute positioning, buttons and the wheel.
 *
 * Positioning is checked by reading the pointer back with GetCursorPos after each move, so the answer comes
 * from Windows rather than from the client's own report. Buttons and the wheel cannot be observed that way,
 * so they are checked through a window that records what it receives: a form that logs mouse events is opened
 * and its log read back. Without that, a button report that is accepted and ignored would look like success.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..', '..', '..')
const client = resolve(root, 'components', 'vhfkey', 'out', 'vhfctl.exe')

const probeScript = resolve(root, 'tmp', 'smoke', 'mouse-event-probe.ps1')
const { writeFileSync } = await import('node:fs')

/*
 * A form that records clicks and wheel events and writes them to a file when it closes. Rendered on top so
 * the synthetic pointer actually lands on it.
 */
writeFileSync(probeScript, `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class MouseProbe : Form {
    public StringBuilder Log = new StringBuilder();
    public string OutPath;

    public MouseProbe() {
        this.Text = "MouseProbe";
        this.StartPosition = FormStartPosition.Manual;
        this.Location = new System.Drawing.Point(50, 50);
        this.Size = new System.Drawing.Size(900, 700);
        this.TopMost = true;
    }
    protected override void OnMouseDown(MouseEventArgs e) {
        Log.AppendLine("DOWN " + e.Button + " at " + e.X + "," + e.Y);
        base.OnMouseDown(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        Log.AppendLine("UP " + e.Button + " at " + e.X + "," + e.Y);
        base.OnMouseUp(e);
    }
    protected override void OnMouseWheel(MouseEventArgs e) {
        Log.AppendLine("WHEEL delta=" + e.Delta);
        base.OnMouseWheel(e);
    }
    protected override void OnFormClosing(FormClosingEventArgs e) {
        if (OutPath != null) File.WriteAllText(OutPath, Log.ToString());
        base.OnFormClosing(e);
    }
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing

$out = Join-Path $env:TEMP 'mouse-probe-log.txt'
Remove-Item $out -Force -ErrorAction SilentlyContinue
$form = New-Object MouseProbe
$form.OutPath = $out
$form.Show()
[System.Windows.Forms.Application]::DoEvents()
Write-Output "READY"
$deadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 40
}
$form.Close()
Write-Output "LOGFILE=$out"
`, 'utf8')

const cursor = async () => {
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
    { encoding: 'buffer', timeout: 20_000 })
  const [x, y] = stdout.toString('utf8').trim().split(',').map(Number)
  return { x, y }
}

console.log('=== absolute positioning ===')
let allAccurate = true
for (const [x, y] of [[100, 100], [1000, 200], [600, 600], [50, 900], [1100, 100]]) {
  await run(client, ['move', String(x), String(y)], { encoding: 'buffer', timeout: 20_000, windowsHide: true })
  await new Promise((r) => setTimeout(r, 250))
  const at = await cursor()
  const dx = Math.abs(at.x - x)
  const dy = Math.abs(at.y - y)
  const ok = dx <= 3 && dy <= 3
  if (!ok) allAccurate = false
  console.log(`  requested ${x},${y}  ->  ${at.x},${at.y}   error ${dx},${dy}   ${ok ? 'OK' : 'OFF'}`)
}
console.log(`  ${allAccurate ? 'all positions accurate' : 'some positions were off'}`)

console.log('\n=== buttons and wheel, through a window that records them ===')
const listener = run('powershell.exe',
  ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript],
  { encoding: 'buffer', timeout: 90_000 })
await new Promise((r) => setTimeout(r, 4000))

await run(client, ['move', '400', '300'], { encoding: 'buffer', timeout: 20_000, windowsHide: true })
await new Promise((r) => setTimeout(r, 300))
await run(client, ['click'], { encoding: 'buffer', timeout: 20_000, windowsHide: true })
await new Promise((r) => setTimeout(r, 400))
await run(client, ['click', '--button', 'right'], { encoding: 'buffer', timeout: 20_000, windowsHide: true })
await new Promise((r) => setTimeout(r, 400))
await run(client, ['dblclick'], { encoding: 'buffer', timeout: 30_000, windowsHide: true })
await new Promise((r) => setTimeout(r, 400))
await run(client, ['scroll', '3'], { encoding: 'buffer', timeout: 20_000, windowsHide: true })
await new Promise((r) => setTimeout(r, 400))
await run(client, ['scroll', '-2'], { encoding: 'buffer', timeout: 20_000, windowsHide: true })
await new Promise((r) => setTimeout(r, 800))

const listenerResult = await listener
const logFile = /LOGFILE=(.+)/.exec(listenerResult.stdout.toString('utf8'))?.[1]?.trim()
console.log(`  listener said: ${logFile ?? '(no log path)'}`)

if (logFile) {
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    `Get-Content -LiteralPath '${logFile}' -ErrorAction SilentlyContinue`], { encoding: 'buffer', timeout: 20_000 })
  const lines = stdout.toString('utf8').replace(/\uFEFF/g, '').trim().split(/\r?\n/).filter(Boolean)
  console.log(`  events recorded: ${lines.length}`)
  for (const l of lines) console.log(`    ${l}`)
  const hasLeft = lines.some((l) => l.startsWith('DOWN Left'))
  const hasRight = lines.some((l) => l.startsWith('DOWN Right'))
  const wheels = lines.filter((l) => l.startsWith('WHEEL')).length
  console.log(`\n  left button: ${hasLeft ? 'received' : 'MISSING'}`)
  console.log(`  right button: ${hasRight ? 'received' : 'MISSING'}`)
  console.log(`  wheel events: ${wheels}`)
} else {
  console.log('  no log file, so buttons and wheel could not be confirmed')
}
