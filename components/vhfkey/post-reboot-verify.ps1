# post-reboot-verify.ps1 — reinstall and verify both virtual devices after a reboot, then report by email.
#
# The machine accumulated device state over a long session of driver installs, and the virtual keyboard
# stopped producing input while the virtual mouse, from the same code and the same framework, kept working.
# Everything the code controls was checked and found correct, and the version of the driver that had been
# verified working earlier failed in exactly the same way — so the remaining variable is the machine's own
# state, which a reboot clears.
#
# This runs once at logon so the answer arrives without anyone having to watch for it. It is written to be
# legible in the email on its own, because the result is the only thing that will be visible afterwards.

$ErrorActionPreference = 'Continue'
$root = 'C:\Users\Admin\Documents\GitHub\video-factory'
$logPath = Join-Path $root 'components\vhfkey\post-reboot-verify.log'
$lines = New-Object System.Collections.Generic.List[string]

function Say($m) {
  $lines.Add($m)
  Write-Output $m
}

function Save { [System.IO.File]::WriteAllLines($logPath, $lines, (New-Object System.Text.UTF8Encoding($false))) }

function Send-Report($subject, $body) {
  try {
    $secretFile = 'C:\Users\Admin\Documents\GitHub\dsh-mail-notify\secret.txt'
    if (-not (Test-Path $secretFile)) { Say "  (no secret file, email skipped)"; return }
    $auth = (Get-Content $secretFile -Raw).Trim()

    $mail = New-Object System.Net.Mail.MailMessage
    $mail.From = New-Object System.Net.Mail.MailAddress 'moodlee@qq.com'
    $mail.To.Add('moodlee@qq.com')
    $mail.Subject = $subject
    $mail.Body = $body
    $mail.BodyEncoding = [System.Text.Encoding]::UTF8

    # Port 587 with STARTTLS. Port 465 is implicit TLS, which SmtpClient does not implement: EnableSsl means
    # STARTTLS to it, so 465 fails with a generic send error and no explanation.
    $client = New-Object System.Net.Mail.SmtpClient 'smtp.qq.com', 587
    $client.EnableSsl = $true
    $client.Credentials = New-Object System.Net.NetworkCredential 'moodlee@qq.com', $auth
    $client.Timeout = 60000
    $client.Send($mail)
    $client.Dispose()
    Say '  email sent'
  } catch {
    Say "  email failed: $($_.Exception.Message)"
  }
}

Say "post-reboot verification  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$os = Get-CimInstance Win32_OperatingSystem
Say ("boot time: {0}   uptime: {1} minutes" -f $os.LastBootUpTime.ToString('HH:mm:ss'), [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalMinutes, 1))
Say ''

# --- clean slate ---------------------------------------------------------------------------------
Say '=== removing every previous node and package ==='
$enum = & pnputil /enum-drivers 2>&1 | Out-String
foreach ($b in ($enum -split "(?m)^\s*$" | Where-Object { $_ -match 'vhfhid|vhfkey' })) {
  $name = ([regex]::Match($b, 'Published Name:\s*(\S+)')).Groups[1].Value
  if ($name) { & pnputil /delete-driver $name /uninstall /force 2>&1 | Out-Null; Say "  deleted $name" }
}
Start-Sleep -Seconds 3
$targets = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
  $_.FriendlyName -like '*Virtual HID*' -or $_.InstanceId -like 'VHF\*' -or
  $_.InstanceId -like 'HID\*VHF*' -or $_.InstanceId -like 'HID\VID_1234*'
})
foreach ($d in $targets) { & pnputil /remove-device $d.InstanceId 2>&1 | Out-Null }
Say "  removed $($targets.Count) device(s)"
Start-Sleep -Seconds 3
$left = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID*' -or $_.InstanceId -like 'VHF\*' })
Say "  remaining: $($left.Count)"
Say ''
Save

# --- install -------------------------------------------------------------------------------------
Say '=== installing ==='
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'components\vhfkey\clean-install.ps1') *>&1 |
  Select-Object -Last 12 | ForEach-Object { Say "  $_" }
Start-Sleep -Seconds 5
Save

$nodes = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*Virtual HID*' })
Say "nodes present: $($nodes.Count)"
foreach ($n in $nodes) { Say "  $($n.FriendlyName) [$($n.Status)]  $($n.InstanceId)" }
Say ''
Save

# --- interfaces ----------------------------------------------------------------------------------
Say '=== device interfaces, in the order a client sees them ==='
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'components\vhfkey\smoke\list-interfaces.ps1') 2>&1 |
  ForEach-Object { Say "  $_" }
Say ''
Save

# --- keyboard ------------------------------------------------------------------------------------
Say '=== keyboard (typed into Notepad and read back as hex) ==='
$orig = (Get-WinUserLanguageList).LanguageTag -join ','
try {
  Set-WinUserLanguageList (New-WinUserLanguageList 'en-US') -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
  $kb = & node (Join-Path $root 'components\vhfkey\smoke\verify-virtual-keyboard.mjs') 2>&1 | Out-String
  foreach ($l in ($kb -split "`r?`n")) { if ($l.Trim()) { Say "  $l" } }
} catch {
  Say "  keyboard test failed to run: $($_.Exception.Message)"
} finally {
  try {
    $r = New-WinUserLanguageList 'zh-Hans-CN'; $r.Add('en-US')
    Set-WinUserLanguageList $r -Force -ErrorAction SilentlyContinue
  } catch { }
}
Say ''
Save

# --- mouse ---------------------------------------------------------------------------------------
Say '=== mouse (absolute positioning, buttons, wheel) ==='
try {
  $ms = & node (Join-Path $root 'components\vhfkey\smoke\verify-virtual-mouse.mjs') 2>&1 | Out-String
  foreach ($l in ($ms -split "`r?`n")) { if ($l.Trim()) { Say "  $l" } }
} catch {
  Say "  mouse test failed to run: $($_.Exception.Message)"
}
Say ''
Save

# --- verdict and report --------------------------------------------------------------------------
$text = $lines -join "`n"
$kbOk = $text -match 'sent:\s+"VirtualKeyboard Works 12345"' -and $text -match 'received: "VirtualKeyboard Works 12345"'
$msOk = $text -match 'all positions accurate' -and $text -match 'left button: received'
$mouseWorks = $text -match 'HID-compliant mouse'

Say '=== verdict ==='
Say ("  keyboard: {0}" -f $(if ($kbOk) { 'WORKING' } elseif ($text -match 'result:\s+DIFFERENT') { 'no input' } else { 'unknown' }))
Say ("  mouse:    {0}" -f $(if ($msOk) { 'WORKING' } else { 'no input confirmed' }))
Save

$subject = "DSH 任务完成（全部结束）｜虚拟键盘与鼠标复验：键盘 $(if ($kbOk) { '通过' } else { '未通过' })、鼠标 $(if ($msOk) { '通过' } else { '未通过' })"
$body = @"
重启后自动复验的结果。

键盘：$(if ($kbOk) { '通过' } else { '未通过' })
鼠标：$(if ($msOk) { '通过' } else { '未通过' })

完整日志见：
$logPath

日志内容：

$text
"@
Send-Report $subject $body
Say ''
Say "log: $logPath"
Save
