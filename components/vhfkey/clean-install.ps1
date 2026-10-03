# clean-install.ps1 — remove every trace of the driver, then install it from scratch.
#
# A plain reinstall leaves the previous device nodes behind, and a node that no longer matches the INF keeps
# its old virtual HID children in a Disconnected state. Those stale nodes are not harmless: the client opens
# the first device interface it finds, so it can end up talking to an orphan whose reports go nowhere, and the
# symptom is a device that reports OK and does nothing.
#
# Delete the driver package first. That uninstalls every device using it, which is what releases the nodes so
# they can be removed at all — while the package is installed they refuse, because the service still holds
# them.

$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = $PSScriptRoot | Split-Path -Parent | Split-Path -Parent }

function Say($m) { Write-Output $m }

Say '=== 1. delete the driver packages ==='
$enum = & pnputil /enum-drivers 2>&1 | Out-String
$blocks = $enum -split "(?m)^\s*$" | Where-Object { $_ -match 'vhfhid|vhfkey' }
if ($blocks.Count -eq 0) { Say '  none published' }
foreach ($b in $blocks) {
  $name = ([regex]::Match($b, 'Published Name:\s*(\S+)')).Groups[1].Value
  $orig = ([regex]::Match($b, 'Original Name:\s*(\S+)')).Groups[1].Value
  if ($name) {
    $r = & pnputil /delete-driver $name /uninstall /force 2>&1
    $ok = ($r | Select-String 'successfully') -ne $null
    Say "  $name ($orig): $(if ($ok) { 'deleted' } else { 'FAILED' })"
  }
}
Start-Sleep -Seconds 3

Say ''
Say '=== 2. remove every remaining node and orphaned child ==='
$targets = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
  $_.FriendlyName -like '*Virtual HID*' -or
  $_.InstanceId -like 'VHF\*' -or
  $_.InstanceId -like 'HID\*VHF*' -or
  $_.InstanceId -like 'HID\VID_1234*'
})
foreach ($d in $targets) {
  $r = & pnputil /remove-device $d.InstanceId 2>&1
  $ok = ($r | Select-String 'successfully') -ne $null
  Say "  $($d.InstanceId): $(if ($ok) { 'removed' } else { 'kept' })"
}
if ($targets.Count -eq 0) { Say '  nothing to remove' }
Start-Sleep -Seconds 3

$left = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
  $_.FriendlyName -like '*Virtual HID*' -or $_.InstanceId -like 'VHF\*'
})
Say "  remaining: $($left.Count)"
if ($left.Count -gt 0) {
  Say '  refusing to install on top of a leftover node, because the client would have no way to tell the'
  Say '  stale device from the new one. Remove the leftovers (or reboot) and run this again.'
  exit 5
}

Say ''
Say '=== 3. install ==='
& (Join-Path $PSScriptRoot 'install-run.ps1')
exit $LASTEXITCODE
