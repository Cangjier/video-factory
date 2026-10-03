# monitor.ps1 — log whether the virtual mouse moves the pointer, alongside the console connection count.
#
# Written to avoid the mistake that invalidated an earlier run: two copies of a previous probe both parked
# the cursor at the same spot every few seconds, so they fought each other and every measurement taken while
# they ran. This one never moves the pointer by any other means. It only asks the virtual device for a
# position and records where the pointer ended up, alternating between two targets so that a request is
# always a real change from wherever the pointer already is.
#
# The console connection count is recorded with every sample, because the earlier attempt to correlate the
# two used the presence of the agent's window, which is always present and therefore told us nothing. A TCP
# connection count does change when a session attaches and detaches.

param(
  [int]$Minutes = 8,
  [int]$IntervalSeconds = 4
)

Add-Type -AssemblyName System.Windows.Forms

$client = 'C:\Users\Admin\Documents\GitHub\video-factory\components\vhfkey\out\vhfctl.exe'
$log = 'C:\Users\Admin\Documents\GitHub\video-factory\components\vhfkey\monitor.log'
$lines = New-Object System.Collections.Generic.List[string]
function Save { [System.IO.File]::WriteAllLines($log, $lines, (New-Object System.Text.UTF8Encoding($false))) }

function ConsoleConnections {
  try {
    $pids = @(Get-CimInstance Win32_Process -Filter "Name='CuteCloud.exe'" -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessId })
    if ($pids.Count -eq 0) { return 0 }
    return @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $pids }).Count
  } catch { return -1 }
}

# Two targets, chosen so that consecutive requests are always a change from the last one.
$targets = @(@(250, 250), @(1000, 650))
$landed = 0
$total = 0
$end = (Get-Date).AddMinutes($Minutes)

$lines.Add("monitor started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  every ${IntervalSeconds}s for ${Minutes}m")
$lines.Add('time | conn | target | from | after | exit | moved')
Save

$i = 0
while ((Get-Date) -lt $end) {
  $t = $targets[$i % 2]
  $i++
  $conn = ConsoleConnections
  $before = [System.Windows.Forms.Cursor]::Position

  $null = & $client move $t[0] $t[1] 2>&1
  $code = $LASTEXITCODE
  Start-Sleep -Milliseconds 300

  $after = [System.Windows.Forms.Cursor]::Position
  $moved = ([math]::Abs($after.X - $t[0]) -le 3) -and ([math]::Abs($after.Y - $t[1]) -le 3)
  $total++
  if ($moved) { $landed++ }

  $line = "{0} | {1} | {2},{3} | {4},{5} | {6},{7} | {8} | {9}" -f `
    (Get-Date -Format 'HH:mm:ss'), $conn, $t[0], $t[1], $before.X, $before.Y, $after.X, $after.Y, $code, $(if ($moved) { 'YES' } else { 'no' })
  $lines.Add($line)
  Save
  Write-Output $line

  Start-Sleep -Seconds $IntervalSeconds
}

$lines.Add('')
$lines.Add("finished $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')   moved $landed of $total")
Save
Write-Output "finished: moved $landed of $total"
