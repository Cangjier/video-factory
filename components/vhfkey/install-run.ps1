# Install the virtual HID keyboard, in the order that matters.
#
# Two driver defects were found by crashing this machine, and both are now checked before anything is
# loaded:
#
#   1. the image was linked without /DLL, so it was an EXECUTABLE IMAGE rather than a DLL;
#   2. it was built against KMDF 1.35 while the system provides 1.31, so the first framework call
#      dereferenced a null function table.
#
# The published driver package is replaced before the device node is created, because a stale package in
# the driver store is what the device would otherwise bind to.

param([switch]$VerifyOnly)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$component = Join-Path $root 'components\vhfkey'
$driverDir = Join-Path $component 'driver'
$sys = Join-Path $driverDir 'vhfkey.sys'
$log = Join-Path $component 'install-run.log'

function Say($text) {
  Write-Output $text
  Add-Content -Path $log -Value $text -Encoding UTF8
}
Set-Content -Path $log -Value "install run $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding UTF8

function Get-KmdfMinor {
  $f = Join-Path $env:SystemRoot 'System32\drivers\Wdf01000.sys'
  $v = (Get-Item $f).VersionInfo.FileVersion
  return [int]([regex]::Match($v, '^\d+\.(\d+)').Groups[1].Value)
}

Say ''
Say '=== 1. verify the image before installing anything ==='
$image = [System.IO.File]::ReadAllBytes($sys)
$pe = [BitConverter]::ToInt32($image, 0x3C)
$chars = [BitConverter]::ToUInt16($image, $pe + 0x16)
$machine = [BitConverter]::ToUInt16($image, $pe + 4)
$isDll = ($chars -band 0x2000) -ne 0
Say "  machine 0x$($machine.ToString('X4'))   characteristics 0x$($chars.ToString('X4'))   DLL=$isDll"

$mapTable = [regex]::Match((Get-Content (Join-Path $component 'out\vhfkey.map') -Raw), 'WdfFunctions_(\d{5})')
$linkedMinor = if ($mapTable.Success) { [int]$mapTable.Groups[1].Value.Substring(2) } else { -1 }
$sysMinor = Get-KmdfMinor
Say "  KMDF linked=$linkedMinor  system=$sysMinor"

if (-not $isDll -or $machine -ne 0x8664 -or $linkedMinor -lt 0 -or $linkedMinor -gt $sysMinor) {
  Say ''
  Say '  REFUSING TO INSTALL: the image fails a check that previously caused a bugcheck.'
  exit 6
}
Say '  all checks pass'

if ($VerifyOnly) { exit 0 }

Say ''
Say '=== 2. remove any existing device and driver package ==='
$devices = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'ROOT\HIDCLASS*' -and $_.FriendlyName -like '*Virtual HID*' })
foreach ($d in $devices) {
  Say "  removing device $($d.InstanceId)"
  Say ((& pnputil /remove-device $d.InstanceId 2>&1) -join "`n")
}
$enum = & pnputil /enum-drivers 2>&1 | Out-String
foreach ($block in ($enum -split "(?m)^\s*$" | Where-Object { $_ -match 'vhfkey' })) {
  $name = ([regex]::Match($block, 'Published Name:\s*(\S+)')).Groups[1].Value
  if ($name) {
    Say "  deleting package $name"
    Say ((& pnputil /delete-driver $name /uninstall /force 2>&1) -join "`n")
  }
}

$leftovers = @(Get-ChildItem 'C:\Windows\System32\DriverStore\FileRepository' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'vhfkey*' })
if ($leftovers.Count -gt 0) {
  Say "  removing $($leftovers.Count) leftover store director(ies)"
  foreach ($l in $leftovers) { Remove-Item $l.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
Say "  store is clean: $((@(Get-ChildItem 'C:\Windows\System32\DriverStore\FileRepository' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'vhfkey*' })).Count -eq 0)"

# The binary the INF installs is the one in the driver directory, which is not where the build writes
# its output. A mismatch there has already sent a stale, crashing binary to the driver store twice, so
# the two are compared before anything is published.
Say ''
Say '  comparing the staged binary with the built one:'
$built = Join-Path $component 'out\vhfkey.sys'
$staged = Join-Path $driverDir 'vhfkey.sys'
if (-not (Test-Path $built)) { Say '  no build output; run build.ps1 first'; exit 5 }
$builtHash = (Get-FileHash $built -Algorithm SHA256).Hash
$stagedHash = (Get-FileHash $staged -Algorithm SHA256).Hash
Say "    out:    $((Get-Item $built).Length) bytes  sha $($builtHash.Substring(0,16))"
Say "    staged: $((Get-Item $staged).Length) bytes  sha $($stagedHash.Substring(0,16))"
if ($builtHash -ne $stagedHash) {
  Say ''
  Say '  REFUSING TO INSTALL: the staged binary is not the one that was built.'
  Say '  Installing it would load whatever the driver directory happens to hold.'
  exit 6
}
Say '    match'

Say ''
Say '=== 3. publish the driver package ==='
Say ((& pnputil /add-driver (Join-Path $driverDir 'vhfkey.inf') /install 2>&1) -join "`n")

Say ''
Say '=== 4. confirm the store holds the verified build ==='
$store = @(Get-ChildItem 'C:\Windows\System32\DriverStore\FileRepository' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'vhfkey*' })
foreach ($s in $store) {
  foreach ($f in (Get-ChildItem $s.FullName -Filter '*.sys')) {
    $b = [System.IO.File]::ReadAllBytes($f.FullName)
    $p = [BitConverter]::ToInt32($b, 0x3C)
    $c = [BitConverter]::ToUInt16($b, $p + 0x16)
    $dll = ($c -band 0x2000) -ne 0
    Say "  $($s.Name): $($f.Length) bytes  DLL=$dll"
    if (-not $dll) { Say '  REFUSING TO CONTINUE: the store holds a non-DLL binary'; exit 6 }
  }
}

Say ''
Say '=== 5. create the device node ==='
# This is the step the machine crashed at on previous attempts, so the device is created only after the
# verified package is in the store.
$devcon = Get-ChildItem (Join-Path $root 'vendor\wdk\tools') -Recurse -Filter 'devcon.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if ($null -eq $devcon) { Say '  devcon.exe not found'; exit 4 }
$devconOut = & $devcon.FullName install (Join-Path $driverDir 'vhfkey.inf') 'root\vhfkey' 2>&1
Say "  exit code: $LASTEXITCODE"
Say (($devconOut | ForEach-Object { "  $_" }) -join "`n")

Say ''
Say '=== 6. result ==='
Start-Sleep -Seconds 3
$after = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID*' -or ($_.InstanceId -like 'ROOT\HIDCLASS*' -and $_.FriendlyName) })
if ($after.Count -gt 0) {
  foreach ($d in $after) {
    Say "  $($d.FriendlyName)  [$($d.Status)]  problem=$($d.ProblemDescription)"
    Say "    instance: $($d.InstanceId)"
  }
} else {
  Say '  no device appeared'
}
$svc = Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'vhfkey' }
if ($svc) { Say "  service vhfkey: state=$($svc.State) start=$($svc.StartMode)" } else { Say '  service vhfkey: not registered' }
Say ''
Say "  log: $log"
