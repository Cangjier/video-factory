# Sign and install the virtual HID keyboard.
#
# The driver is unsigned, so it needs both test signing and integrity-check bypass. This machine has
# served time in the input stack already as an unsigned filter driver, and the same two flags that let
# that load are what these need: an unsigned kernel driver cannot load without them, at any privilege
# level.
#
# The device is root-enumerated: there is no hardware to detect, so the INF declares a root node and
# Windows creates it on request. That is what `pnputil /add-driver` plus a devnode creation achieves.

param(
  [switch]$Uninstall,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$component = Join-Path $root 'components\vhfkey'
$output = Join-Path $component 'out'
$driver = Join-Path $component 'driver'

function Step($text) { Write-Output ''; Write-Output "=== $text ===" }

if ($Uninstall) {
  Step 'removing the device and its driver'
  $devices = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID Keyboard*' }
  foreach ($d in $devices) {
    Write-Output "  removing $($d.InstanceId)"
    & pnputil /remove-device $d.InstanceId 2>&1 | ForEach-Object { "    $_" }
  }
  $published = & pnputil /enum-drivers 2>&1 | Out-String
  if ($published -match 'vhfkey') {
    Write-Output '  the driver package is still published; remove it with:'
    Write-Output '    pnputil /delete-driver oem<NN>.inf /uninstall'
  }
  Write-Output '  done'
  exit 0
}

Step '1. prerequisites'
$bcd = & bcdedit /enum '{current}' 2>&1 | Out-String
$testSigning = $bcd -match 'testsigning\s+Yes'
$noIntegrity = $bcd -match 'nointegritychecks\s+Yes'
Write-Output "  testsigning       : $testSigning"
Write-Output "  nointegritychecks : $noIntegrity"
if (-not $testSigning -and -not $noIntegrity) {
  Write-Output ''
  Write-Output '  An unsigned driver cannot load. Run the following as administrator and restart:'
  Write-Output '    bcdedit /set testsigning on'
  Write-Output '    bcdedit /set nointegritychecks on'
  exit 2
}

$sys = Join-Path $output 'vhfkey.sys'
$exe = Join-Path $output 'vhfkeyctl.exe'
if (-not (Test-Path $sys)) { throw "driver not built: $sys" }
Write-Output "  driver: $sys  ($([math]::Round((Get-Item $sys).Length/1KB,1)) KB)"

if ($SkipInstall) { Write-Output '  --SkipInstall: stopping here'; exit 0 }

Step '2. sign the driver package'
# A self-signed certificate is enough for test signing. The certificate's own trust level does not
# matter to the loader in this mode; the presence of a signature does.
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -like '*VhfKeyTest*' } | Select-Object -First 1
if ($null -eq $cert) {
  Write-Output '  creating a self-signed code-signing certificate ...'
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject 'CN=VhfKeyTest' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -NotAfter (Get-Date).AddYears(3)
}
Write-Output "  certificate: $($cert.Thumbprint)"

$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if ($null -eq $signtool) { throw 'signtool.exe not found; a driver package needs a signature to install' }

# The catalog is what pnputil actually validates. Signing only the binary leaves the package rejected
# with "does not contain digital signature information", because the INF's integrity is carried by the
# catalog rather than by the .sys alone.
$inf2cat = Get-ChildItem (Join-Path $root 'vendor\wdk\tools\c\bin') -Recurse -Filter 'Inf2Cat.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $inf2cat) { throw 'Inf2Cat.exe not found in the WDK package; the catalog cannot be generated' }

Write-Output '  generating the catalog ...'
& $inf2cat.FullName /driver:"$driver" /os:10_X64 2>&1 | ForEach-Object { "    $_" }
$cat = Join-Path $driver 'vhfkey.cat'
if (-not (Test-Path $cat)) { throw 'catalog generation failed' }

Write-Output '  signing the binary and the catalog ...'
foreach ($file in @($sys, $cat)) {
  & $signtool.FullName sign /v /fd SHA256 /a /s My /n 'VhfKeyTest' $file 2>&1 |
    Where-Object { $_ -match 'Successfully signed|Error|error' } | ForEach-Object { "    $_" }
}
Write-Output "  binary:  $((Get-AuthenticodeSignature $sys).Status)"
Write-Output "  catalog: $((Get-AuthenticodeSignature $cat).Status)"

Step '3. publish the driver package'
# The INF must sit beside the binary it installs.
Copy-Item $sys (Join-Path $driver 'vhfkey.sys') -Force
& pnputil /add-driver (Join-Path $driver 'vhfkey.inf') /install 2>&1 | ForEach-Object { "  $_" }

Step '4. create the device'
# Root-enumerated devices are created rather than discovered, so the devnode is added explicitly.
$existing = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID Keyboard*' }
if ($existing) {
  Write-Output "  device already present: $($existing[0].InstanceId)"
} else {
  Write-Output '  creating root\vhfkey ...'
  & pnputil /add-device /class HIDClass /bus root /device vhfkey 2>&1 | ForEach-Object { "  $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-Output '  pnputil could not create the device; trying devcon-style creation is not available here.'
    Write-Output '  The device can also be created by installing the INF against the root enumerator from Device'
    Write-Output '  Manager ("Add legacy hardware").'
  }
}

Step '5. start and verify'
Start-Sleep -Seconds 3
$dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID Keyboard*' }
if ($dev) {
  foreach ($d in $dev) {
    Write-Output "  $($d.FriendlyName)"
    Write-Output "    instance: $($d.InstanceId)"
    Write-Output "    status:   $($d.Status)"
    Write-Output "    problem:  $($d.ProblemDescription)"
  }
} else {
  Write-Output '  no device appeared'
}

Write-Output ''
Write-Output '  Verify with:'
Write-Output "    $exe probe"
Write-Output "    $exe type `"Hello from the virtual keyboard`""
