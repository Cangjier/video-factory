# Restart the driver's device and report what the driver traced.
#
# The build, signing and publishing live in install-run.ps1, which orders them correctly; this only does the
# two things that make a new binary take effect and then shows the result. Keeping one copy of the packaging
# logic is the point: duplicating it here produced a second, differently-ordered version that signed before
# comparing and broke the check.
#
# A new binary only takes effect once the device restarts, because a driver already loaded stays loaded.

param(
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$trace = Join-Path $env:SystemRoot 'vhfkey-trace.log'

$devices = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID*' })
Write-Output "devices: $($devices.Count)"

if (-not $NoRestart) {
  # Cleared first, so whatever appears belongs to this run and not to a previous one.
  Remove-Item $trace -Force -ErrorAction SilentlyContinue
  foreach ($d in $devices) {
    $r = & pnputil /restart-device $d.InstanceId 2>&1
    $line = ($r | Select-String -Pattern 'restarted successfully|failed|not ') | Select-Object -First 1
    Write-Output "  $($d.InstanceId): $($line -replace '\s+$','')"
  }
  Start-Sleep -Seconds 4
}

Write-Output ''
Write-Output '=== device state ==='
foreach ($d in @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID*' })) {
  $detail = & pnputil /enum-devices /instanceid $d.InstanceId 2>&1 | Out-String
  $code = [regex]::Match($detail, 'Problem Code:\s*(\S+)').Groups[1].Value
  $stat = [regex]::Match($detail, 'Problem Status:\s*(\S+)').Groups[1].Value
  Write-Output "  $($d.InstanceId)  $($d.Status)  problemCode='$code'  problemStatus='$stat'"
}

Write-Output ''
Write-Output '=== driver trace ==='
if (Test-Path $trace) {
  Get-Content $trace | ForEach-Object { "  $_" }
} else {
  Write-Output "  $trace does not exist"
  Write-Output '  the driver reached neither DriverEntry nor EvtDeviceAdd, or could not create the file'
}

Write-Output ''
Write-Output '=== client probe ==='
$exe = Join-Path $root 'components\vhfkey\out\vhfkeyctl.exe'
if (Test-Path $exe) {
  & $exe probe 2>&1 | ForEach-Object { "  $_" }
  Write-Output "  exit code: $LASTEXITCODE"
}
