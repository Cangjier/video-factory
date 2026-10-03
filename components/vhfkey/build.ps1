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
# The directory the INF installs from, which is not where the build writes. Step 3c keeps the two
# identical, because a stale binary here has already been installed and crashed the machine twice.
$driver = Join-Path $component 'driver'
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

# Which KMDF version to build against.
#
# Not the newest available. The driver links against a version-specific function table — the symbol is
# named WdfFunctions_01035 for 1.35 — and the running Wdf01000.sys only provides the tables up to its own
# version. A driver built for a newer minor version than the target system supports gets a null table
# and faults on the first framework call:
#
#   vhfkey!WdfDriverCreate+0x52:
#     mov  r10, qword ptr [vhfkey!WdfFunctions_01035]
#     call qword ptr [r10+rax]      <- access violation
#
# The system here runs Wdf01000.sys 1.31, so the version is read from that file rather than guessed.
# Taking the newest directory (1.35, meant for Windows 11) is what produced the crash.
$systemWdf = Join-Path $env:SystemRoot 'System32\drivers\Wdf01000.sys'
if (-not (Test-Path $systemWdf)) { throw "cannot determine the KMDF version: $systemWdf not found" }
$systemWdfVersion = (Get-Item $systemWdf).VersionInfo.FileVersion
$minor = [int]([regex]::Match($systemWdfVersion, '^\d+\.(\d+)').Groups[1].Value)
$wantedName = "1.$minor"
$kmdfMajor = 1
Write-Output "  system KMDF: $systemWdfVersion  -> building against $wantedName"

$wdfVersion = Join-Path (Join-Path $wdfInclude 'kmdf') $wantedName | Get-Item -ErrorAction SilentlyContinue
if ($null -eq $wdfVersion) {
  # Fall back to the newest version that is not newer than the system supports, rather than to the
  # newest overall.
  $wdfVersion = Get-ChildItem (Join-Path $wdfInclude 'kmdf') -Directory -ErrorAction SilentlyContinue |
    Where-Object { [version]$_.Name -le [version]$wantedName } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  if ($null -ne $wdfVersion) {
    Write-Output "  $wantedName is not in the WDK; using $($wdfVersion.Name) instead"
  }
}
if ($null -eq $wdfVersion) { throw 'no kmdf version directory at or below the system version was found' }
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
# structure declares a user-mode FileHandle instead of a kernel DeviceObject, so the field the driver sets
# does not exist. _AMD64_ must carry its underscores, because the SDK headers test for that exact spelling
# and otherwise fail with "No Target Architecture".
#
# KMDF_VERSION_MAJOR and KMDF_VERSION_MINOR are the framework version the driver declares it needs, and they
# must be defined. wdffuncenum.h builds WdfMinimumVersionRequired from them:
#
#   ULONG WdfMinimumVersionRequired =
#       #if defined(KMDF_MINIMUM_VERSION_REQUIRED)  KMDF_MINIMUM_VERSION_REQUIRED
#       #elif defined(KMDF_VERSION_MINOR)           KMDF_VERSION_MINOR
#       #else                                       (ULONG)(-1)
#       #endif
#
# With neither macro defined the value becomes 0xFFFFFFFF, which reads as "this driver requires framework
# version 4294967295". WdfVersionBind rejects that as an invalid parameter, so the driver fails to start
# before FxDriverEntry ever calls DriverEntry — no crash, no log, just CM_PROB_FAILED_DRIVER_ENTRY and
# 0xC000000D. The WDK sets both macros from the KmdfVersion property; a hand-rolled build has to set them.
$defines = @(
  '/D_KERNEL_MODE',
  '/D_WIN64',
  '/D_AMD64_',
  '/DPOOL_NX_OPTIN=1',
  '/DDBG=0',
  '/DNDEBUG',
  '/DKERNEL',
  "/DKMDF_VERSION_MAJOR=$kmdfMajor",
  "/DKMDF_VERSION_MINOR=$minor"
)

$commonArgs = @(
  # /utf-8 states that the sources are UTF-8. Without it the compiler reads them in the system code
  # page — 936 on this machine — and warns C4819 that the file contains characters it cannot represent.
  # The comments are in Chinese, so the warning fires on every build; more importantly, a byte sequence
  # that decodes differently in the two encodings could silently change what a comment or string says.
  '/nologo', '/c', '/GS-', '/Gz', '/W3', '/WX-', '/Zi', '/utf-8', '/Zc:wchar_t-',
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
  # /DRIVER implies the entry point and the subsystem, but it does not set the DLL characteristic, and
  # a kernel driver must be a DLL. Without /DLL the image links as an EXECUTABLE IMAGE with
  # characteristics 0x22 rather than 0x2022, and the loader takes the wrong path for it. The symptom is
  # a bugcheck 0x7E — SYSTEM_THREAD_EXCEPTION_NOT_HANDLED with an access violation — the moment the
  # driver package is installed, before any device node exists. Dumpbin names it plainly:
  # "File Type: EXECUTABLE IMAGE".
  #
  # The entry point is left to the libraries, and that is deliberate: for a KMDF driver it must be
  # FxDriverEntry, as the WDK's own KMDF integration states —
  #
  #   <EntryPointSymbol>FxDriverEntry</EntryPointSymbol>
  #
  # FxDriverEntry lives in WdfDriverEntry.lib and is what fills in WdfDriverGlobals and the version's
  # function table before the driver's DriverEntry is called. Passing /ENTRY:DriverEntry instead (which
  # this script used to do) makes the driver's own DriverEntry the entry point, so none of that
  # initialisation runs, the globals stay null, and the first framework call dereferences a null class
  # pointer:
  #
  #   vhfkey!WdfDriverCreate+0x52:
  #     mov  r10, qword ptr [vhfkey!WdfFunctions_01031]   <- null
  #     call qword ptr [r10+rax]                          <- fault
  #
  # The entry point must be the framework's, not the driver's own. WdfDriverEntry.lib defines
  # FxDriverEntry, and it is what fills in WdfDriverGlobals and the version's function table before
  # calling the driver's DriverEntry. Naming DriverEntry here — which this script used to do — means none
  # of that initialisation runs, the globals stay null, and the first framework call faults:
  #
  #   vhfkey!WdfDriverCreate+0x52:
  #     mov  rcx, qword ptr [vhfkey!WdfDriverGlobals]     <- null
  #     mov  r10, qword ptr [vhfkey!WdfFunctions_01031]   <- null
  #     call qword ptr [r10+rax]                          <- fault
  #
  # The debugger calls this "AV.Dereference: NullClassPtr" and the bugcheck is 0x7E. Leaving the entry
  # point unspecified is not a fix either: the linker then picks its own, the framework code is never
  # referenced, and the image collapses to a 5 KB stub with no WDF machinery — which is why FxDriverEntry
  # is named explicitly rather than left to a default.
  '/nologo', '/DRIVER', '/DLL', '/SUBSYSTEM:NATIVE', '/ENTRY:FxDriverEntry',
  # The WDF loader finds a driver's framework binding through an import descriptor for WDFLDR that
  # wdfldr.lib contributes as __IMPORT_DESCRIPTOR_WDFLDR. Nothing in this driver calls a WDFLDR function
  # directly — the KMDF calls are static stubs resolved inside the driver — so with /OPT:REF the linker
  # treats the descriptor as unreferenced and discards it.
  #
  # The result is a driver that links cleanly, passes every structural check, and whose import table names
  # only ntoskrnl: WdfLdr never recognises it, so no framework binding happens, FxDriverEntry fails before
  # it can call the driver's DriverEntry, and the device reports CM_PROB_FAILED_DRIVER_ENTRY with
  # 0xC000000D. Nothing in the driver's own code runs, which is why registry and file traces both stayed
  # empty — the driver looked like it was failing inside itself while it never started at all.
  #
  # /INCLUDE forces the descriptor in. The binary grows by the .idata section when it works.
  '/INCLUDE:__IMPORT_DESCRIPTOR_WDFLDR',
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
Step '3b. verify the image is a loadable kernel driver'
# ---------------------------------------------------------------------------------------------
# These properties are checked here rather than discovered by loading the driver, because the failure
# mode is a machine crash rather than an error message. Each one is read straight out of the PE header,
# so the check needs no debugging tools.
$image = [System.IO.File]::ReadAllBytes($sys)
$peOffset = [BitConverter]::ToInt32($image, 0x3C)
$machine = [BitConverter]::ToUInt16($image, $peOffset + 4)
$subsystem = [BitConverter]::ToUInt16($image, $peOffset + 0x5C)
$characteristics = [BitConverter]::ToUInt16($image, $peOffset + 0x16)

$problems = @()
if ($machine -ne 0x8664) { $problems += "machine is 0x$($machine.ToString('X4')), expected 0x8664 (x64)" }
if ($subsystem -ne 1) { $problems += "subsystem is $subsystem, expected 1 (native)" }
if (-not ($characteristics -band 0x2000)) {
  $problems += "IMAGE_FILE_DLL (0x2000) is not set — characteristics are 0x$($characteristics.ToString('X4')); a kernel driver must link with /DLL"
}

# The entry point must be the framework's, not the driver's own. The map file names whatever the linker
# chose, so the check is exact rather than a guess, and a driver built with /ENTRY:DriverEntry is
# rejected here instead of at load time with a null class pointer.
$entryRva = [BitConverter]::ToUInt32($image, $peOffset + 0x28)
$entrySymbol = 'unresolved'
# Asking dumpbin for the name is authoritative. Deriving it from the map file is not: the map lists
# section-relative offsets (0001:00001a28) while the PE header holds an RVA (0x2A28), so the two differ by
# the section's virtual address. An earlier version of this check ignored that and reported a correct
# build as unresolved.
$dumpbin = Get-ChildItem 'C:\BuildTools' -Recurse -Filter 'dumpbin.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'Hostx64\\x64' } | Select-Object -First 1
if ($null -ne $dumpbin) {
  $headersOut = & $dumpbin.FullName /headers $sys 2>&1 | Out-String
  $entryMatch = [regex]::Match($headersOut, '(?m)^\s*[0-9A-F]+\s+entry point\s+\([0-9A-F]+\)\s+(\S+)')
  if ($entryMatch.Success) { $entrySymbol = $entryMatch.Groups[1].Value }
}
Write-Output "  entry point:     RVA 0x$('{0:X8}' -f $entryRva)  -> $entrySymbol"
if ($entrySymbol -eq 'unresolved') {
  Write-Output '  entry point:     could not be resolved; the name check is skipped'
} elseif ($entrySymbol -ne 'FxDriverEntry') {
  $problems += "the entry point is $entrySymbol, but a KMDF driver's must be FxDriverEntry — without it WdfDriverGlobals is never initialised and the first framework call faults"
}

# The framework version table is identified by the symbol WdfFunctions_01031, and it is listed in the
# map file rather than present in the image's data: the first version of this check searched the binary
# for the string, found nothing, and so reported a correct build as broken. Asking for a table the system
# does not provide is an access violation on the first framework call, which is what a version mismatch
# produced.
$mapFile = Join-Path $output 'vhfkey.map'
$linkedTable = $null
if (Test-Path $mapFile) {
  $tableMatch = [regex]::Match((Get-Content $mapFile -Raw), 'WdfFunctions_(\d{5})')
  if ($tableMatch.Success) { $linkedTable = $tableMatch.Groups[1].Value }
}
if ($null -ne $linkedTable) {
  $linkedMinor = [int]$linkedTable.Substring(2)
  Write-Output "  KMDF table:      WdfFunctions_$linkedTable  (system supports 1.$minor)"
  if ($linkedMinor -gt $minor) {
    $problems += "the driver requests WdfFunctions_$linkedTable (KMDF 1.$linkedMinor) but the system's Wdf01000.sys provides only 1.$minor"
  }
} else {
  Write-Output '  KMDF table:      not found in the map file (unexpected for a KMDF driver)'
  $problems += 'no WdfFunctions_ table symbol found; the driver does not appear to be linked as a KMDF driver'
}

Write-Output "  machine:         0x$($machine.ToString('X4'))"
Write-Output "  subsystem:       $subsystem"
Write-Output "  characteristics: 0x$($characteristics.ToString('X4'))  (0x2000 = DLL)"
foreach ($p in $problems) { Write-Output "  ❌ $p" }

if ($problems.Count -gt 0) {
  Write-Output ''
  Write-Output '  Refusing to report success: this image would crash the machine when installed.'
  exit 6
}
Write-Output '  ✅ the image is a native x64 DLL, which is what the kernel loader requires'

# The framework version the driver declares it needs, read straight out of .data. wdffuncenum.h derives it
# from KMDF_VERSION_MINOR and falls back to (ULONG)(-1) when that macro is undefined, which reads as
# "requires framework version 4294967295". WdfVersionBind rejects that, and the driver then fails to start
# before DriverEntry runs — no crash and no log, only CM_PROB_FAILED_DRIVER_ENTRY with 0xC000000D. The value
# is checked here because nothing else in the pipeline notices.
$dataSection = $null
for ($i = 0; $i -lt [BitConverter]::ToUInt16($image, $peOffset + 6); $i++) {
  $sectionOffset = $peOffset + 24 + [BitConverter]::ToUInt16($image, $peOffset + 20) + $i * 40
  $sectionName = [System.Text.Encoding]::ASCII.GetString($image, $sectionOffset, 8).Trim([char]0)
  if ($sectionName -eq '.data') {
    $dataSection = @{
      VirtualAddress = [BitConverter]::ToUInt32($image, $sectionOffset + 12)
      RawPointer     = [BitConverter]::ToUInt32($image, $sectionOffset + 20)
    }
    break
  }
}
$minVersion = -1
if ($null -ne $dataSection -and (Test-Path $mapFile)) {
  $minMatch = [regex]::Match((Get-Content $mapFile -Raw),
    "0003:[0-9a-f]{8}\s+WdfMinimumVersionRequired\s+([0-9a-f]{16})")
  if ($minMatch.Success) {
    $minRva = [Convert]::ToInt64($minMatch.Groups[1].Value, 16) - 0x180000000
    $minOffset = $dataSection.RawPointer + ($minRva - $dataSection.VirtualAddress)
    if ($minOffset -ge 0 -and $minOffset + 4 -le $image.Length) {
      $minVersion = [BitConverter]::ToUInt32($image, $minOffset)
    }
  }
}
Write-Output "  KMDF min version: $minVersion  (the driver requires 1.$minor)"
if ($minVersion -ne $minor) {
  $problems += "WdfMinimumVersionRequired is $minVersion, not $minor — KMDF_VERSION_MINOR was not defined at compile time, so WdfVersionBind will reject the driver"
}

# ---------------------------------------------------------------------------------------------
Step '3c. place the verified binary where the INF will find it'
# ---------------------------------------------------------------------------------------------
# The INF copies vhfkey.sys from the driver directory, not from out/, so the two have to be the same
# file. Leaving the copy to be done by hand has now caused two crashes: the driver directory held a
# binary built against KMDF 1.35 while out/ held the corrected 1.31 build, and the package that got
# installed was the stale one. The build does the copy so that installing what was just built is the
# only thing it can do.
$stagedSys = Join-Path $driver 'vhfkey.sys'
Copy-Item $sys $stagedSys -Force
$builtHash = (Get-FileHash $sys -Algorithm SHA256).Hash
$stagedHash = (Get-FileHash $stagedSys -Algorithm SHA256).Hash
if ($builtHash -ne $stagedHash) { throw 'staged binary does not match the built one' }
Write-Output "  staged: $stagedSys  ($([math]::Round((Get-Item $stagedSys).Length/1KB,1)) KB, sha $($stagedHash.Substring(0,16)))"
# A stale catalog would no longer cover the binary, and the package would be rejected at install time.
Remove-Item (Join-Path $driver 'vhfkey.cat') -Force -ErrorAction SilentlyContinue
Write-Output '  removed the stale catalog; install.ps1 regenerates and signs it'

# ---------------------------------------------------------------------------------------------
Step '4. build the user-mode client'
# ---------------------------------------------------------------------------------------------

if (-not $DriverOnly) {
  $clientSrc = Join-Path $component 'client'
  $clientObj = Join-Path $build 'client'
  New-Item -ItemType Directory -Force -Path $clientObj | Out-Null

  # /utf-8 for the same reason as the driver: the client includes vhfkey.h, whose comments are in
  # Chinese, so without it the same C4819 warning appears on every build.
  $clientArgs = @(
    '/nologo', '/c', '/W3', '/WX-', '/Zi', '/MD', '/utf-8',
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
