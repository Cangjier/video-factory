# probe-loop.ps1 — try the virtual mouse every few seconds and log whether it lands.
#
# The device worked earlier in the session and stopped, and the one thing that changed is whether a console
# session was driving the pointer. A console client that tracks its own cursor can overwrite a position it did
# not set, which makes the device look dead while working whenever nobody is connected.
#
# One attempt cannot separate "never works" from "overridden right now". Attempts spread over several minutes
# can: if failures turn into successes while the console is disconnected and back into failures when it
# returns, the device works and the console is what hides it.
#
# Everything is timestamped so the change can be lined up with when the connection dropped.

param(
  [int]$Minutes = 6,
  [int]$IntervalSeconds = 5
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Probe {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
}
'@

$client = 'C:\Users\Admin\Documents\GitHub\video-factory\components\vhfkey\out\vhfctl.exe'
$log = 'C:\Users\Admin\Documents\GitHub\video-factory\components\vhfkey\probe-loop.log'
$lines = New-Object System.Collections.Generic.List[string]

function Save { [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false))) }

# The console agent's window title is a direct signal of whether a session is attached.
function ConsoleState {
  $titles = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle } |
    ForEach-Object { $_.MainWindowTitle })
  $agent = @($titles | Where-Object { $_ -match 'CuteCloud|云|Cloud' })
  if ($agent.Count) { "agent-window:$($agent[0])" } else { 'no-agent-window' }
}

$targets = @(@(200,200), @(900,300), @(400,700), @(1000,800), @(600,450))
$landed = 0
$total = 0
$end = (Get-Date).AddMinutes($Minutes)

$lines.Add("probe started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  every ${IntervalSeconds}s for ${Minutes}m")
$lines.Add('columns: time | target | from | after | exit | landed | console')
Save

$i = 0
while ((Get-Date) -lt $end) {
  $t = $targets[$i % $targets.Count]
  $tx = $t[0]; $ty = $t[1]
  $i++

  # Park the cursor elsewhere first so "did not move" cannot be confused with "was already there".
  try { [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(60, 60) } catch { }
  Start-Sleep -Milliseconds 120
  $before = [System.Windows.Forms.Cursor]::Position

  $out = & $client move $tx $ty 2>&1
  $code = $LASTEXITCODE
  Start-Sleep -Milliseconds 300

  $after = [System.Windows.Forms.Cursor]::Position
  $ok = ([math]::Abs($after.X - $tx) -le 3) -and ([math]::Abs($after.Y - $ty) -le 3)
  $total++
  if ($ok) { $landed++ }

  $state = ConsoleState
  $line = "{0} | {1},{2} | {3},{4} | {5},{6} | {7} | {8} | {9}" -f `
    (Get-Date -Format 'HH:mm:ss'), $tx, $ty, $before.X, $before.Y, $after.X, $after.Y, $code, $(if ($ok) { 'YES' } else { 'no' }), $state
  $lines.Add($line)
  Save
  Write-Output $line

  Start-Sleep -Seconds $IntervalSeconds
}

$lines.Add("")
$lines.Add("finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')   landed $landed of $total")
Save
Write-Output "finished: landed $landed of $total"
