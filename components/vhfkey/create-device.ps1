# Create the root-enumerated device node for the virtual keyboard, capturing everything that happens.
#
# The previous attempts were interrupted before their output was recorded, so the reason the node was
# never created is still unknown. Everything here is written to a log file as it happens, and the
# steps that can fail are run without stopping the script, so one failure does not hide the ones after
# it.
#
# Nothing here removes or reconfigures anything that existed before: the only state this changes is the
# driver package and the device node it creates, both of which `-Uninstall` reverses.

param([switch]$Uninstall)

$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$component = Join-Path $root 'components\vhfkey'
$driverDir = Join-Path $component 'driver'
$log = Join-Path $component 'device-node.log'

function Say($text) {
  Write-Output $text
  Add-Content -Path $log -Value $text -Encoding UTF8
}

Set-Content -Path $log -Value "device node run: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding UTF8
Say ""

if ($Uninstall) {
  Say '=== removing the device and driver ==='
  $devices = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID Keyboard*' }
  foreach ($d in $devices) {
    Say "  removing $($d.InstanceId)"
    Say ((& pnputil /remove-device $d.InstanceId 2>&1) -join "`n")
  }
  exit 0
}

# ---------------------------------------------------------------------------------------------
Say '=== 1. is the device already there ==='
# ---------------------------------------------------------------------------------------------
$existing = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID Keyboard*' })
if ($existing.Count -gt 0) {
  Say "  already present ($($existing.Count)):"
  foreach ($d in $existing) {
    Say "    $($d.InstanceId)  status=$($d.Status)  problem=$($d.ProblemDescription)"
  }
  Say '  nothing to create'
} else {
  Say '  not present'
}

# ---------------------------------------------------------------------------------------------
Say ''
Say '=== 2. republish the driver package ==='
# ---------------------------------------------------------------------------------------------
# The INF changed, so the published copy is stale. `pnputil /add-driver` replaces it in place and keeps
# the same oem number when the INF name is unchanged.
$addOutput = & pnputil /add-driver (Join-Path $driverDir 'vhfkey.inf') /install 2>&1
Say (($addOutput | ForEach-Object { "  $_" }) -join "`n")

# ---------------------------------------------------------------------------------------------
Say ''
Say '=== 3. confirm the package is published ==='
# ---------------------------------------------------------------------------------------------
$enum = & pnputil /enum-drivers 2>&1 | Out-String
$blocks = $enum -split "(?m)^\s*$" | Where-Object { $_ -match 'vhfkey' }
if ($blocks) {
  foreach ($b in $blocks) {
    Say (($b -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { "  $($_.Trim())" }) -join "`n")
  }
} else {
  Say '  the package is not listed as published'
}

# ---------------------------------------------------------------------------------------------
Say ''
Say '=== 4. create the device node ==='
# ---------------------------------------------------------------------------------------------
if ($existing.Count -eq 0) {
  $devcon = Get-ChildItem (Join-Path $root 'vendor\wdk\tools') -Recurse -Filter 'devcon.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
  if ($null -eq $devcon) {
    Say '  devcon.exe not found'
  } else {
    Say "  devcon: $($devcon.FullName)"
    # `devcon install <inf> <hardware id>` creates the node and installs the driver on it. The exit code
    # and the full output are both recorded, because the message is the whole point of this run.
    $devconOutput = & $devcon.FullName install (Join-Path $driverDir 'vhfkey.inf') 'root\vhfkey' 2>&1
    Say "  exit code: $LASTEXITCODE"
    Say (($devconOutput | ForEach-Object { "  $_" }) -join "`n")
  }
}

# ---------------------------------------------------------------------------------------------
Say ''
Say '=== 5. result ==='
# ---------------------------------------------------------------------------------------------
Start-Sleep -Seconds 2
$after = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID Keyboard*' })
if ($after.Count -gt 0) {
  foreach ($d in $after) {
    Say "  $($d.FriendlyName)"
    Say "    instance: $($d.InstanceId)"
    Say "    status:   $($d.Status)"
    Say "    problem:  $($d.ProblemDescription)"
  }
  Say ''
  Say '  LowerFilters on the node should contain vhf:'
  foreach ($d in $after) {
    $regPath = "HKLM:\SYSTEM\CurrentControlSet\Enum\$($d.InstanceId)"
    $key = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    if ($key) { Say "    $regPath" }
  }
} else {
  Say '  no device appeared'
}

Say ''
Say '=== 6. driver service ==='
$svc = Get-CimInstance Win32_SystemDriver -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'vhfkey' }
if ($svc) {
  Say "  vhfkey: state=$($svc.State) start=$($svc.StartMode) path=$($svc.PathName)"
} else {
  Say '  vhfkey service is not registered'
}
Say ''
Say "  log: $log"
