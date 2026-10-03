# Build the virtual HID keyboard: the kernel driver and its user-mode client.
#
# Sources of the toolchain, each from where it actually lives rather than from a Visual Studio install:
#   compiler and linker   C:\BuildTools (VS Build Tools, installed separately)
#   kernel headers, libs   the WDK NuGet package, extracted into vendor/wdk/tools
#   kernel libs for VHF    vhfkm.lib inside that package
#
# The driver is unsigned. It loads only with test signing enabled, which is already on for this machine
# and is reversible with `bcdedit /deletevalue testsigning`.

param(
  [switch]$Force,
  [switch]$DriverOnly
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$component = Join-Path $root 'components\vhfkey'
$tools = Join-Path $root 'vendor\wdk\tools'
$output = Join-Path $component 'out'
$build = Join-Path $component 'build'
New-Item -ItemType Directory -Force -Path $output, $build | Out-Null

function Step($text) { Write-Output ''; Write-Output "=== $text ===" }

# ---------------------------------------------------------------------------------------------
Step '1. toolchain'
# ---------------------------------------------------------------------------------------------

$cl = 'C:\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe'
if (-not (Test-Path $cl)) {
  $found = Get-ChildItem 'C:\BuildTools' -Recurse -Filter 'cl.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'Hostx64\\x64' } | Select-Object -First 1
  if ($null -eq $found) {
    throw 'cl.exe not found under C:\BuildTools; the Build Tools installation is incomplete'
  }
  $cl = $found.FullName
}
$binDir = Split-Path $cl -Parent
Write-Output "  compiler: $binDir"

# Kernel headers and libraries, extracted from the WDK package on first use.
$wdkMark = Join-Path $tools 'extracted.ok'
if ($Force -or -not (Test-Path $wdkMark)) {
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $nupkg = Join-Path $root 'vendor\wdk\dl\wdk.nupkg'
  if (-not (Test-Path $nupkg)) { throw "missing WDK package: $nupkg" }
  Write-Output '  extracting the WDK package ...'
  $tempZip = Join-Path $tools 'wdk.zip'
  Copy-Item $nupkg $tempZip -Force
  try {
    Expand-Archive -Path $tempZip -DestinationPath $tools -Force
    Set-Content -Path $wdkMark -Value 'ok' -Encoding ascii
  } finally {
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
  }
}

# The package lays the WDK out under a leading "c/", which is not a useful prefix.
$wdkRoot = Join-Path $tools 'c'
if (-not (Test-Path $wdkRoot)) {
  $candidate = Get-ChildItem $tools -Recurse -Directory -Filter 'km' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'Include' } | Select-Object -First 1
  if ($null -eq $candidate) { throw 'could not locate the WDK km include directory after extraction' }
  $wdkRoot = Split-Path (Split-Path $candidate.FullName -Parent) -Parent
}
$kmInclude = Join-Path $wdkRoot 'Include\10.0.26100.0\km'
$kmLib = Join-Path $wdkRoot 'Lib\10.0.26100.0\km\x64'
$wdfInclude = Join-Path $wdkRoot 'Include\wdf'
# A kernel build needs more than the km directory alone: wdm.h pulls ntdef.h out of shared, and the
# CRT headers a driver links against come from the same WDK layout. Omitting either produces
# "cannot open include file: ntdef.h", which says nothing about which path is missing.
$kmIncludeRoot = Join-Path $wdkRoot 'Include\10.0.26100.0'
$kmShared = Join-Path $kmIncludeRoot 'shared'
$kmCrt = Join-Path $kmIncludeRoot 'km\crt'
Write-Output "  km include: $kmInclude"
Write-Output "  km shared:  $kmShared"
Write-Output "  km crt:     $kmCrt"
Write-Output "  km lib:     $kmLib"
if (-not (Test-Path $kmInclude)) { throw "km include not found: $kmInclude" }
if (-not (Test-Path $kmShared)) { throw "km shared include not found: $kmShared" }
if (-not (Test-Path $kmLib)) { throw "km lib not found: $kmLib" }

# The user-mode client needs the Windows SDK headers and libraries, which live in the Kits directory.
$sdkInclude = 'C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0'
$sdkLib = 'C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0'
if (-not (Test-Path $sdkInclude)) { throw "Windows SDK include not found: $sdkInclude" }
Write-Output "  sdk include: $sdkInclude"

# A compatible WDF version directory: the newest available, since the API is additive.
$wdfVersion = Get-ChildItem (Join-Path $wdfInclude 'kmdf') -Directory -ErrorAction SilentlyContinue |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if ($null -eq $wdfVersion) { throw 'no kmdf version directory found in the WDK' }
Write-Output "  kmdf:        $($wdfVersion.FullName)"

# CRC32 support for the environment: some driver headers include crt headers that expect it.
$vcInclude = 'C:\BuildTools\VC\Tools\MSVC\14.44.35207\include'

# ---------------------------------------------------------------------------------------------
Step '2. compile the driver'
# ---------------------------------------------------------------------------------------------

$driverSrc = Join-Path $component 'driver'
$driverObj = Join-Path $build 'driver'
New-Item -ItemType Directory -Force -Path $driverObj | Out-Null

# ntdef.h and specstrings.h come from the Windows SDK, not from the WDK package: the WDK's "shared"
# directory holds only the newer contract headers. Both directories are needed, and their absence
# produces "cannot open include file: ntdef.h" while wdm.h is what actually asked for it.
$sdkIncludeRoot = 'C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0'
$sdkShared = Join-Path $sdkIncludeRoot 'shared'
$sdkUm = Join-Path $sdkIncludeRoot 'um'
# The C runtime headers live in the SDK's ucrt directory, and the MSVC include directory carries only
# the C++ standard library. A driver that includes any CRT header needs both.
$sdkUcrt = Join-Path $sdkIncludeRoot 'ucrt'

$includeArgs = @(
  "/I$kmInclude",
  "/I$kmShared",
  "/I$sdkShared",
  "/I$sdkUm",
  "/I$sdkUcrt",
  "/I$($wdfVersion.FullName)",
  "/I$wdfInclude",
  "/I$driverSrc",
  "/I$vcInclude"
)

# Defines a kernel driver build expects.
#
# _KERNEL_MODE is not defined by the WDK headers themselves, and vhf.h branches on it: without it the
# structure declares a user-mode FileHandle instead of a kernel DeviceObject, so the field the driver
# sets does not exist. _AMD64_ must carry its underscores, because the SDK headers test for that exact
# spelling and otherwise fail with "No Target Architecture".
$defines = @(
  '/D_KERNEL_MODE',
  '/D_WIN64',
  '/D_AMD64_',
  '/DPOOL_NX_OPTIN=1',
  '/DDBG=0',
  '/DNDEBUG',
  '/DKERNEL',
  '/D_WDF_MAJOR_VERSION=1'
)

$commonArgs = @(
  '/nologo', '/c', '/GS-', '/Gz', '/W3', '/WX-', '/Zi', '/Zc:wchar_t-',
  '/Zc:inline', '/Zc:strictStrings', '/Zc:threadSafeInit-',
  '/Oy-', '/Gy', '/Gw', '/Zp8'
)

Write-Output '  compiling vhfkey.c ...'
$clArgs = @($commonArgs + $defines + $includeArgs + @(
  "/Fo$driverObj\\",
  "/Fd$driverObj\vhfkey.pdb",
  (Join-Path $driverSrc 'vhfkey.c')
))
Write-Output "    cl $($clArgs -join ' ')"
& $cl @clArgs 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Output ''
  Write-Output '  compilation failed. The errors above name the offending construct.'
  exit 1
}

# ---------------------------------------------------------------------------------------------
Step '3. link the driver'
# ---------------------------------------------------------------------------------------------

$link = Join-Path $binDir 'link.exe'
$sys = Join-Path $output 'vhfkey.sys'
# The library paths are built as single strings. Writing them as '/LIBPATH:' + $path inside an array
# literal produces two separate arguments, and the linker then reports the option as having no
# argument — a message that points at the option rather than at the concatenation that split it.
# The MSVC library directory is not derived from the toolset path by counting parent hops: that path
# shape has already been guessed wrong once. It is located by looking for a known library instead.
$msvcLib = $null
foreach ($candidate in (Get-ChildItem 'C:\BuildTools\VC\Tools\MSVC' -Directory -ErrorAction SilentlyContinue)) {
  $lib = Join-Path $candidate.FullName 'lib\x64'
  if (Test-Path (Join-Path $lib 'libcmt.lib')) { $msvcLib = $lib; break }
}
if ($null -eq $msvcLib) {
  $found = Get-ChildItem 'C:\BuildTools\VC\Tools\MSVC' -Recurse -Filter 'libcmt.lib' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $msvcLib = $found.DirectoryName }
}
if ($null -eq $msvcLib) { throw 'MSVC x64 library directory not found (looked for libcmt.lib)' }
Write-Output "  msvc lib:    $msvcLib"
# The framework libraries live under Lib/wdf/kmdf rather than beside the kernel libraries, in a
# directory named after the framework version, so the version chosen for the includes selects the
# matching library directory.
$kmdfLib = Join-Path $wdkRoot ("Lib\wdf\kmdf\x64\" + $wdfVersion.Name)
if (-not (Test-Path $kmdfLib)) { throw "KMDF library directory not found: $kmdfLib" }
Write-Output "  kmdf lib:    $kmdfLib"
$linkArgs = @(
  '/nologo', '/DRIVER', '/SUBSYSTEM:NATIVE', '/ENTRY:DriverEntry',
  "/LIBPATH:$kmLib",
  "/LIBPATH:$kmdfLib",
  "/LIBPATH:$msvcLib",
  "/OUT:$sys",
  "/PDB:$(Join-Path $output 'vhfkey.pdb')",
  "/MAP:$(Join-Path $output 'vhfkey.map')",
  '/DEBUG', '/OPT:REF', '/OPT:ICF',
  '/MACHINE:X64',
  # The user-mode CRT is not part of a driver. When the linker pulls it in for the buffer-overflow
  # support objects, those objects reference QueryPerformanceCounter and the thread and process id
  # routines through the user-mode import library, which a driver cannot use. The kernel provides what
  # is actually needed through ntoskrnl, so the user-mode CRT is excluded outright.
  '/NODEFAULTLIB:libcmt.lib',
  '/NODEFAULTLIB:msvcrt.lib',
  '/NODEFAULTLIB:libvcruntime.lib',
  (Join-Path $driverObj 'vhfkey.obj'),
  'wdm.lib', 'ntoskrnl.lib', 'hal.lib', 'wmilib.lib', 'vhfkm.lib',
  'ntstrsafe.lib', 'BufferOverflowK.lib', 'libcntpr.lib',
  'wdfldr.lib', 'wdfdriverentry.lib',
  # Repeated so the kernel imports are resolved after the other libraries have had their say about
  # which symbols they need.
  'ntoskrnl.lib', 'hal.lib'
)
Write-Output '  linking ...'
& $link @linkArgs 2>&1 | ForEach-Object { "    $_" }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sys)) {
  Write-Output ''
  Write-Output '  link failed. A missing symbol usually means another library must be added to the list.'
  exit 1
}
$sysInfo = Get-Item $sys
Write-Output "  ✅ $($sysInfo.FullName)  $([math]::Round($sysInfo.Length/1KB,1)) KB"

# ---------------------------------------------------------------------------------------------
Step '4. build the user-mode client'
# ---------------------------------------------------------------------------------------------

if (-not $DriverOnly) {
  $clientSrc = Join-Path $component 'client'
  $clientObj = Join-Path $build 'client'
  New-Item -ItemType Directory -Force -Path $clientObj | Out-Null

  $clientArgs = @(
    '/nologo', '/c', '/W3', '/WX-', '/Zi', '/MD',
    "/I$($sdkInclude)\um", "/I$($sdkInclude)\shared", "/I$($sdkInclude)\ucrt",
    "/I$clientSrc", "/I$driverSrc",
    "/I$vcInclude",
    "/Fo$clientObj\\",
    "/Fd$clientObj\vhfkeyctl.pdb",
    (Join-Path $clientSrc 'vhfkeyctl.cpp')
  )
  Write-Output '  compiling vhfkeyctl.cpp ...'
  & $cl @clientArgs 2>&1 | ForEach-Object { "    $_" }
  if ($LASTEXITCODE -ne 0) {
    Write-Output '  client compilation failed'
    exit 1
  }

  $exe = Join-Path $output 'vhfkeyctl.exe'
  $clientLinkArgs = @(
    '/nologo', '/SUBSYSTEM:CONSOLE', '/MACHINE:X64',
    "/LIBPATH:$(Join-Path $sdkLib 'um\x64')",
    "/LIBPATH:$(Join-Path $sdkLib 'ucrt\x64')",
    "/LIBPATH:$msvcLib",
    "/OUT:$exe",
    '/DEBUG',
    (Join-Path $clientObj 'vhfkeyctl.obj'),
    'setupapi.lib', 'kernel32.lib', 'user32.lib', 'advapi32.lib',
    'ucrt.lib', 'vcruntime.lib', 'msvcrt.lib'
  )
  Write-Output '  linking client ...'
  & $link @clientLinkArgs 2>&1 | ForEach-Object { "    $_" }
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exe)) {
    Write-Output '  client link failed'
    exit 1
  }
  Write-Output "  ✅ $exe  $([math]::Round((Get-Item $exe).Length/1KB,1)) KB"
}

# ---------------------------------------------------------------------------------------------
Step '5. summary'
# ---------------------------------------------------------------------------------------------

Get-ChildItem $output -File | ForEach-Object { "  $($_.Name)  $([math]::Round($_.Length/1KB,1)) KB" }
Write-Output ''
Write-Output '  Next: sign and install with install.ps1'
