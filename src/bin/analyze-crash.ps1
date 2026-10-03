# Analyse a kernel crash dump with kd and report the parts that matter.
#
# The faulting module and the function it faulted in are what identify the bug; everything else in
# !analyze -v is context. The symbol path is set so the report names functions rather than bare
# addresses, and symbols are cached locally so a second run does not re-download.

param(
  [Parameter(Mandatory = $true)][string]$Dump,
  [string]$OutFile
)

$ErrorActionPreference = 'Continue'

$kd = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\kd.exe'
if (-not (Test-Path $kd)) { throw "kd.exe not found at $kd" }
if (-not (Test-Path $Dump)) { throw "dump not found: $Dump" }

$stamp = [System.IO.Path]::GetFileNameWithoutExtension($Dump)
if (-not $OutFile) { $OutFile = Join-Path $env:TEMP "kd-$stamp.txt" }

# A command file avoids every layer of shell quoting; kd reads it with -cf.
$cmdFile = Join-Path $env:TEMP "kd-$stamp.cmds"
@(
  '.symfix'
  '.reload'
  '!analyze -v'
  'q'
) | Set-Content -Path $cmdFile -Encoding ASCII

$sym = "srv*$env:TEMP\symbols*https://msdl.microsoft.com/download/symbols"

Write-Output "analysing $Dump"
Write-Output "  output: $OutFile"
Write-Output ''

# kd writes to stdout; the whole transcript is captured and then filtered.
& $kd -z $Dump -y $sym -cf $cmdFile 2>&1 | Out-File -FilePath $OutFile -Encoding UTF8
$exit = $LASTEXITCODE
Write-Output "  kd exit code: $exit   lines: $((Get-Content $OutFile).Count)"
Write-Output ''

$lines = Get-Content $OutFile
$interesting = @(
  'BUGCHECK_CODE', 'BUGCHECK_P1', 'BUGCHECK_P2', 'BUGCHECK_P3', 'BUGCHECK_P4',
  'MODULE_NAME', 'IMAGE_NAME', 'IMAGE_VERSION', 'PROCESS_NAME', 'FAILURE_BUCKET_ID',
  'FAILURE_ID_HASH', 'STACK_COMMAND', 'SYMBOL_NAME', 'FOLLOWUP_NAME', 'BLACKBOX',
  'FAULTING_IP', 'EXCEPTION_CODE', 'EXCEPTION_STR', 'TRAP_FRAME',
  'Probably caused by', 'SYMBOL_STACK_INDEX', 'CUSTOMER_CRASH_COUNT'
)

foreach ($key in $interesting) {
  $hits = $lines | Select-String -Pattern $key -SimpleMatch
  foreach ($h in $hits) { Write-Output "  $($h.Line.Trim())" }
}

Write-Output ''
Write-Output '=== stack trace ==='
# The stack is printed after the STACK_TEXT marker and continues until a blank line.
$inStack = $false
foreach ($line in $lines) {
  if ($line -match 'STACK_TEXT') { $inStack = $true; continue }
  if ($inStack) {
    if ($line -match '^\s*$') { break }
    Write-Output "  $($line.TrimEnd())"
  }
}
