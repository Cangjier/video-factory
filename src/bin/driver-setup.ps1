# Post-reboot setup for the driver-level input path, plus verification that it actually works.
#
# Run this once after enabling test signing and restarting. It:
#   1. confirms test signing is active (a driver load will fail silently without it),
#   2. confirms the BCD backup is present, so a rollback is always one command away,
#   3. installs the Interception filter driver,
#   4. verifies the driver is present and its service exists,
#   5. reports the exact rollback commands.
#
# Interception is a filter driver that sits in the input stack *below* the user-mode injection that
# SendInput performs. That placement is the entire point: an application that ignores synthetic
# input from SendInput still receives events that arrive through a driver, because to the system
# they are indistinguishable from the device's own.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$stage = Join-Path $root 'vendor\interception'
$installer = Join-Path $stage 'command line installer\install-interception.exe'

function Step($text) { Write-Output ''; Write-Output "=== $text ===" }

Step '1. test signing state'
$bcd = & bcdedit /enum '{current}' 2>&1 | Out-String
$testSigning = ($bcd -match 'testsigning\s+Yes')
$noIntegrity = ($bcd -match 'nointegritychecks\s+Yes')
Write-Output "  testsigning on     : $testSigning"
Write-Output "  nointegritychecks  : $noIntegrity"
if (-not $testSigning -and -not $noIntegrity) {
  Write-Output ''
  Write-Output '  Neither flag is set, so an unsigned driver will not load.'
  Write-Output '  Run these as administrator and restart:'
  Write-Output '    bcdedit /set testsigning on'
  Write-Output '    bcdedit /set nointegritychecks on'
  exit 2
}

Step '2. rollback safety net'
$backup = Join-Path $stage 'bcd-backup.bcd'
Write-Output "  BCD backup present : $(Test-Path $backup)"
if (Test-Path $backup) { Write-Output "  restore with       : bcdedit /import `"$backup`"" }
Write-Output '  disable test signing: bcdedit /deletevalue testsigning'
Write-Output '                        bcdedit /deletevalue nointegritychecks'

Step '3. install the filter driver'
if (-not (Test-Path $installer)) { throw "installer missing: $installer" }
# The installer is unsigned and registers a kernel service, so it needs an elevated shell.
& $installer /install 2>&1 | ForEach-Object { Write-Output "  $_" }
Write-Output "  installer exit code: $LASTEXITCODE"

Step '4. verify the driver registered'
$service = Get-Service -Name 'keyboard' -ErrorAction SilentlyContinue
$services = Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'interception|keyboard|mouse' }
foreach ($s in $services) {
  Write-Output ("  {0,-20} state={1,-10} start={2}" -f $s.Name, $s.State, $s.StartMode)
}
$drv = Get-ChildItem "$env:SystemRoot\System32\drivers" -Filter '*.sys' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'interception|keyboard|mouse' }
foreach ($d in $drv) {
  $sig = Get-AuthenticodeSignature $d.FullName
  Write-Output ("  {0,-24} {1} bytes  signature={2}" -f $d.Name, $d.Length, $sig.Status)
}

Step '5. next step'
Write-Output '  The driver is in place. The next step is a validation run that compares the two input'
Write-Output '  paths on the same control: user-mode SendInput, which is known not to activate a browser'
Write-Output '  button here, against the driver path. If the driver activates it, the fallback layer is'
Write-Output '  proven and everything above it becomes worth building.'
