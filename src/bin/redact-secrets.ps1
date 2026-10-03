# Redact credential-shaped strings from the captured API contract document.
#
# The document is a protocol capture, so it contains live examples — and those examples carry the
# values that were in the captured traffic. VolcEngine object-storage URLs embed the access key id in
# X-Tos-Credential and the request signature in X-Tos-Signature, so a copy of a response body puts both
# into the repository. The URLs themselves have expired, but the access key id is still an identifier
# that should not be published, and GitHub's secret scanning declines the push regardless.
#
# The structure is what the document is for, so only the values are replaced; the parameter names, the
# dates and the surrounding JSON all stay, and the examples remain readable as examples.
#
# Run from the repository root. Idempotent: once the values are placeholders, a second run changes
# nothing.

param(
  [string[]]$Paths,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
if (-not $Paths -or $Paths.Count -eq 0) {
  $Paths = @('docs')
}

# Each rule is a pattern and the text that replaces the matched value. The patterns deliberately match
# a shape rather than one known secret, so a credential captured later is caught too.
$rules = @(
  # X-Tos-Credential=<access key id>%2F<date>%2F<region>%2F<service>%2Frequest
  # The key id ends at the percent-encoded slash that introduces the date.
  @{ Pattern = 'X-Tos-Credential=AK[A-Za-z0-9]{10,}'; Replacement = 'X-Tos-Credential=<REDACTED_AK>' },
  # X-Tos-Signature=<64 hex characters>
  @{ Pattern = 'X-Tos-Signature=[0-9a-fA-F]{32,}'; Replacement = 'X-Tos-Signature=<REDACTED_SIGNATURE>' },
  # VolcEngine access key ids in the AKLT / AKTP families, wherever they appear.
  @{ Pattern = '\bAKLT[A-Za-z0-9]{20,}'; Replacement = '<REDACTED_AK>' },
  @{ Pattern = '\bAKTP[A-Za-z0-9]{20,}'; Replacement = '<REDACTED_AK>' },
  # Generic bearer tokens and API keys that may appear in other captures.
  @{ Pattern = 'Bearer\s+[A-Za-z0-9+/=_-]{30,}'; Replacement = 'Bearer <REDACTED_TOKEN>' },
  @{ Pattern = '\bsk-[A-Za-z0-9]{32,}'; Replacement = '<REDACTED_API_KEY>' },
  @{ Pattern = '\bgh[pousr]_[A-Za-z0-9]{30,}'; Replacement = '<REDACTED_GITHUB_TOKEN>' },
  @{ Pattern = '\bAKIA[0-9A-Z]{16}\b'; Replacement = '<REDACTED_AWS_KEY>' }
)

$totalFiles = 0
$totalHits = 0

foreach ($path in $Paths) {
  if (-not (Test-Path $path)) { continue }
  $files = if ((Get-Item $path).PSIsContainer) {
    Get-ChildItem $path -Recurse -File | Where-Object { $_.Extension -in '.md', '.json', '.txt', '.yml', '.yaml', '.js', '.mjs', '.ps1' }
  } else {
    Get-Item $path
  }

  foreach ($file in $files) {
    $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    $original = $text
    $hits = 0

    foreach ($rule in $rules) {
      $found = [regex]::Matches($text, $rule.Pattern)
      if ($found.Count -gt 0) {
        $hits += $found.Count
        $text = [regex]::Replace($text, $rule.Pattern, $rule.Replacement)
      }
    }

    if ($hits -eq 0) { continue }
    $totalFiles++
    $totalHits += $hits
    $relative = $file.FullName.Replace((Get-Location).Path + '\', '')
    Write-Output "  $relative  ($hits 处)"

    if (-not $CheckOnly) {
      # Written back as UTF-8 without a BOM; the document is UTF-8 and a BOM would show up in any diff.
      [System.IO.File]::WriteAllText($file.FullName, $text, (New-Object System.Text.UTF8Encoding($false)))
    }
  }
}

Write-Output ''
if ($CheckOnly) {
  Write-Output "  检查完成：$totalFiles 个文件、$totalHits 处需要脱敏"
  if ($totalHits -gt 0) { exit 1 }
} else {
  Write-Output "  已脱敏：$totalFiles 个文件、$totalHits 处"
}
