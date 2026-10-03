/**
 * Does the virtual keyboard produce keystrokes?
 *
 * The same shape as the mouse check, and for the same reason: a form that logs the events it receives is the
 * one place where the answer does not depend on which window happens to have focus, or on reading a control
 * back out of an application that may report it differently.
 *
 * Two earlier attempts were inconclusive rather than negative. Typing into Notepad and reading the document
 * back cannot distinguish "no keystroke arrived" from "the keystroke went to the wrong window", and a
 * raw-input window and a low-level hook both failed to report the SendInput control keystroke, which means
 * those listeners were broken and said nothing about the device either way.
 *
 * Here the form is shown, activated and focused by the test itself, and it writes every KeyDown and KeyUp
 * with the key code. A SendInput control runs first: if the control is seen, the listener works.
 */
import { writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..', '..')
const client = resolve(root, 'components', 'vhfkey', 'out', 'vhfctl.exe')
const probe = resolve(root, 'tmp', 'smoke', 'keyboard-event-probe.ps1')
const logPath = resolve(root, 'tmp', 'smoke', 'kbd-event-log.txt')
const readyPath = resolve(root, 'tmp', 'smoke', 'kbd-event-ready.txt')

writeFileSync(probe, `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

public class KeyProbe : Form {
    public StringBuilder Log = new StringBuilder();
    public string OutPath;

    public KeyProbe() {
        this.Text = "KeyProbe";
        this.StartPosition = FormStartPosition.Manual;
        this.Location = new System.Drawing.Point(60, 60);
        this.Size = new System.Drawing.Size(800, 600);
        this.TopMost = true;
        this.KeyPreview = true;
    }
    protected override bool ProcessCmdKey(ref Message msg, Keys keyData) {
        Log.AppendLine("CMD " + keyData.ToString());
        Flush();
        return base.ProcessCmdKey(ref msg, keyData);
    }
    protected override void OnKeyDown(KeyEventArgs e) {
        Log.AppendLine("DOWN " + e.KeyCode.ToString() + " (0x" + ((int)e.KeyCode).ToString("X2") + ")");
        Flush();
        base.OnKeyDown(e);
    }
    protected override void OnKeyUp(KeyEventArgs e) {
        Log.AppendLine("UP " + e.KeyCode.ToString());
        Flush();
        base.OnKeyUp(e);
    }
    private void Flush() { if (OutPath != null) File.WriteAllText(OutPath, Log.ToString()); }
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing

Remove-Item '${logPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue
Remove-Item '${readyPath.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue
$f = New-Object KeyProbe
$f.OutPath = '${logPath.replace(/'/g, "''")}'
$f.Show()
$f.Activate()
$f.Focus()
[System.Windows.Forms.Application]::DoEvents()
Set-Content -Path '${readyPath.replace(/'/g, "''")}' -Value "READY"
$end = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $end) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 30
}
$f.Close()
`, 'utf8')

const readLog = async () => {
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    `if (Test-Path '${logPath}') { Get-Content -LiteralPath '${logPath}' -Raw }`],
    { encoding: 'buffer', timeout: 20_000 }).catch(() => ({ stdout: Buffer.alloc(0) }))
  return stdout.toString('utf8').replace(/\uFEFF/g, '').trim()
}

const listener = run('powershell.exe',
  ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe],
  { encoding: 'buffer', timeout: 90_000 })

// Wait for the form to be up rather than guessing at a delay.
for (let i = 0; i < 40 && !(await run('powershell.exe',
  ['-NoLogo', '-NoProfile', '-Command', `Test-Path '${readyPath}'`],
  { encoding: 'buffer', timeout: 10_000 }).then((r) => r.stdout.toString().includes('True')).catch(() => false)); i++) {
  await new Promise((r) => setTimeout(r, 250))
}
await new Promise((r) => setTimeout(r, 800))
console.log('probe window is up')

console.log('\n-- control: SendInput "b" --')
await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
  'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("b")'],
  { timeout: 20_000 }).catch(() => null)
await new Promise((r) => setTimeout(r, 1200))
const control = await readLog()
console.log(control ? control.split(/\r?\n/).map((l) => '  ' + l).join('\n') : '  (nothing — listener is broken, so the next result proves nothing)')

console.log('\n-- virtual keyboard: key A --')
const a = await run(client, ['key', 'A'], { encoding: 'buffer', timeout: 30_000, windowsHide: true })
  .catch((e) => ({ stdout: Buffer.from(String(e.message)), code: e.code }))
console.log(`  client exit=${a.code ?? 0}`)
await new Promise((r) => setTimeout(r, 1200))
const afterA = await readLog()
console.log(afterA ? afterA.split(/\r?\n/).map((l) => '  ' + l).join('\n') : '  (nothing)')

console.log('\n-- virtual keyboard: type "ABC" --')
const b = await run(client, ['type', 'ABC'], { encoding: 'buffer', timeout: 30_000, windowsHide: true })
  .catch((e) => ({ stdout: Buffer.from(String(e.message)), code: e.code }))
console.log(`  client exit=${b.code ?? 0}`)
await new Promise((r) => setTimeout(r, 1500))
const afterAbc = await readLog()
const lines = afterAbc ? afterAbc.split(/\r?\n/).filter(Boolean) : []
console.log(`  total events: ${lines.length}`)
console.log(lines.slice(-10).map((l) => '    ' + l).join('\n'))

await listener.catch(() => null)
