# Desktop input primitives for the computer-use plugin.
#
# Windows only. Every action is a single command so the caller can record exactly what
# was done, and so a failure names the step that failed rather than a batch.
#
# Input goes through SendInput rather than the deprecated mouse_event/keybd_event pair:
# SendInput is the documented way to inject input, it carries the full INPUT union so one
# call covers mouse, keyboard, and Unicode text, and text is sent as UTF-16 scan codes
# rather than by mapping characters onto the current keyboard layout. That last point is
# what makes Chinese text arrive intact.
#
# Usage:
#   desktop.ps1 -Action screenshot -Path out.png [-Region x,y,w,h]
#   desktop.ps1 -Action cursor
#   desktop.ps1 -Action move -X 100 -Y 200 [-Duration 0.2]
#   desktop.ps1 -Action click [-X 100 -Y 200] [-Button left|right|middle] [-Count 1]
#   desktop.ps1 -Action scroll [-Amount -3]
#   desktop.ps1 -Action text -Text "你好"
#   desktop.ps1 -Action key -Text "^s"
#   desktop.ps1 -Action screen
#   desktop.ps1 -Action windows

param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Path,
  [string]$Region,
  [string]$Text,
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [double]$Duration = 0.15,
  [ValidateSet('left', 'right', 'middle')][string]$Button = 'left',
  [int]$Count = 1,
  [int]$Amount = -3
)

$ErrorActionPreference = 'Stop'

# Force UTF-8 on the way out. PowerShell 5.1 writes stdout using the console code page, so window
# titles and any other Chinese text reach a Node parent as mojibake. JSON still parses in that
# state, which makes the damage quiet: a window lookup by title simply never matches.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class Desktop {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEKEYBDUNION u;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct MOUSEKEYBDUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowThreadProcessId(IntPtr hWnd, IntPtr reserved);
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(IntPtr attach, IntPtr attachTo, bool doAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;

    static void Send(INPUT[] inputs) {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) {
            throw new InvalidOperationException(
                "SendInput injected " + sent + " of " + inputs.Length + " events, error " + Marshal.GetLastWin32Error());
        }
    }

    static INPUT Mouse(uint flags, int dx, int dy, uint data) {
        var input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flags;
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = data;
        return input;
    }

    static INPUT Key(ushort vk, ushort scan, uint flags) {
        var input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        return input;
    }

    /// One character, as UTF-16, independent of the active keyboard layout.
    static INPUT[] Char(char c) {
        return new INPUT[] {
            Key(0, (ushort)c, KEYEVENTF_UNICODE),
            Key(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
        };
    }

    static INPUT[] VirtualKey(ushort vk) {
        return new INPUT[] { Key(vk, 0, 0), Key(vk, 0, KEYEVENTF_KEYUP) };
    }

    public static string MoveTo(int x, int y, double seconds) {
        POINT from;
        GetCursorPos(out from);
        int steps = Math.Max(1, (int)(seconds * 60));
        for (int i = 1; i <= steps; i++) {
            int nx = from.X + (int)Math.Round((x - from.X) * (double)i / steps);
            int ny = from.Y + (int)Math.Round((y - from.Y) * (double)i / steps);
            SetCursorPos(nx, ny);
            Thread.Sleep(Math.Max(1, (int)(seconds * 1000 / steps)));
        }
        SetCursorPos(x, y);
        POINT end; GetCursorPos(out end);
        return end.X + "," + end.Y;
    }

    public static string Click(string button, int count) {
        uint down, up;
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }

        for (int i = 0; i < count; i++) {
            if (i > 0) Thread.Sleep(80);
            Send(new INPUT[] { Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0) });
        }
        return "clicked " + button + " x" + count;
    }

    public static string Scroll(int notches) {
        Send(new INPUT[] { Mouse(MOUSEEVENTF_WHEEL, 0, 0, (uint)(notches * 120)) });
        return "scrolled " + notches;
    }

    /// Send literal text. Characters are injected one at a time so a long string cannot
    /// fail as a single opaque batch.
    public static string TypeText(string text) {
        foreach (char c in text) {
            if (c == '\n') { Send(VirtualKey(0x0D)); continue; }
            if (c == '\t') { Send(VirtualKey(0x09)); continue; }
            Send(Char(c));
        }
        return "typed " + text.Length + " chars";
    }

    /// Send a chord such as "^s" (Ctrl+S), "%{F4}" (Alt+F4), or "{ENTER}".
    ///
    /// Built on SendInput rather than SendKeys.SendWait. SendWait depends on a message pump and
    /// on journal hooks, and in this host it silently delivered nothing: typing into a browser
    /// address bar worked while Ctrl+A and Enter did not, which made navigation look broken when
    /// only the chord was. Pressing the modifier down, the key down and up, then the modifier up
    /// is what the input system expects and carries no such dependency.
    public static string SendChord(string chord) {
        string text = chord;
        var sent = new System.Collections.Generic.List<string>();

        while (text.Length > 0) {
            ushort modifier = 0;
            char lead = text[0];
            if (lead == '^') { modifier = 0x11; text = text.Substring(1); }
            else if (lead == '%') { modifier = 0x12; text = text.Substring(1); }
            else if (lead == '+') { modifier = 0x10; text = text.Substring(1); }
            if (text.Length == 0) break;

            var events = new System.Collections.Generic.List<INPUT>();

            // Named key: {ENTER}, {TAB}, {ESC}, {F4}, {DELETE} and friends.
            if (text[0] == '{') {
                int close = text.IndexOf('}');
                if (close < 0) throw new InvalidOperationException("unterminated key name in chord: " + chord);
                string name = text.Substring(1, close - 1).Trim().ToUpperInvariant();
                text = text.Substring(close + 1);
                ushort vk = VirtualKeyFor(name);
                if (modifier != 0) events.Add(Key(modifier, 0, 0));
                events.Add(Key(vk, 0, 0));
                events.Add(Key(vk, 0, KEYEVENTF_KEYUP));
                if (modifier != 0) events.Add(Key(modifier, 0, KEYEVENTF_KEYUP));
                Send(events.ToArray());
                sent.Add(name);
                continue;
            }

            // A plain character, which covers "^s"-style shortcuts and punctuation.
            char c = text[0];
            text = text.Substring(1);
            short scan = VkKeyScan(c);
            if (scan == -1) throw new InvalidOperationException("no virtual key for '" + c + "' in chord: " + chord);

            ushort key = (ushort)(scan & 0xFF);
            byte state = (byte)((scan >> 8) & 0xFF);
            bool needsShift = (state & 1) != 0;
            bool needsCtrl = (state & 2) != 0;
            bool needsAlt = (state & 4) != 0;

            if (needsCtrl) events.Add(Key(0x11, 0, 0));
            if (needsAlt) events.Add(Key(0x12, 0, 0));
            if (needsShift) events.Add(Key(0x10, 0, 0));
            if (modifier != 0) events.Add(Key(modifier, 0, 0));
            events.Add(Key(key, 0, 0));
            events.Add(Key(key, 0, KEYEVENTF_KEYUP));
            if (modifier != 0) events.Add(Key(modifier, 0, KEYEVENTF_KEYUP));
            if (needsShift) events.Add(Key(0x10, 0, KEYEVENTF_KEYUP));
            if (needsAlt) events.Add(Key(0x12, 0, KEYEVENTF_KEYUP));
            if (needsCtrl) events.Add(Key(0x11, 0, KEYEVENTF_KEYUP));
            Send(events.ToArray());
            sent.Add(c.ToString());
        }

        return "sent chord " + chord + " as " + string.Join(" ", sent);
    }

    /// Map a SendKeys key name onto a virtual key code.
    static ushort VirtualKeyFor(string name) {
        switch (name) {
            case "ENTER": case "RETURN": return 0x0D;
            case "TAB": return 0x09;
            case "ESC": case "ESCAPE": return 0x1B;
            case "SPACE": return 0x20;
            case "BACKSPACE": case "BS": return 0x08;
            case "DELETE": case "DEL": return 0x2E;
            case "INSERT": case "INS": return 0x2D;
            case "HOME": return 0x24;
            case "END": return 0x23;
            case "PAGEUP": case "PGUP": return 0x21;
            case "PAGEDOWN": case "PGDN": return 0x22;
            case "UP": return 0x26;
            case "DOWN": return 0x28;
            case "LEFT": return 0x25;
            case "RIGHT": return 0x27;
            case "F1": return 0x70; case "F2": return 0x71; case "F3": return 0x72; case "F4": return 0x73;
            case "F5": return 0x74; case "F6": return 0x75; case "F7": return 0x76; case "F8": return 0x77;
            case "F9": return 0x78; case "F10": return 0x79; case "F11": return 0x7A; case "F12": return 0x7B;
            default:
                if (name.Length == 1) return (ushort)char.ToUpperInvariant(name[0]);
                throw new InvalidOperationException("unsupported key name in chord: " + name);
        }
    }

    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);

    public static string Foreground() {
        IntPtr hwnd = GetForegroundWindow();
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        return WindowJson(hwnd, pid);
    }

    public static string WindowJson(IntPtr hwnd, uint pid) {
        int length = GetWindowTextLength(hwnd);
        var sb = new System.Text.StringBuilder(length + 2);
        GetWindowText(hwnd, sb, sb.Capacity);
        RECT rect; GetWindowRect(hwnd, out rect);
        string title = sb.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"");
        return "{\"handle\":" + hwnd.ToInt64() + ",\"pid\":" + pid + ",\"title\":\"" + title + "\"," +
               "\"x\":" + rect.Left + ",\"y\":" + rect.Top + "," +
               "\"width\":" + (rect.Right - rect.Left) + ",\"height\":" + (rect.Bottom - rect.Top) + "}";
    }

    /// The window's frame as "x,y,w,h", or an empty string when the handle is not a window.
    /// A stale handle is common when a window has just closed, so it is checked rather than
    /// trusted: GetWindowRect on an invalid handle returns a meaningless zeroed rectangle.
    public static string RectOf(IntPtr hWnd) {
        if (!IsWindow(hWnd)) return "";
        RECT r; GetWindowRect(hWnd, out r);
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return "";
        return r.Left + "," + r.Top + "," + w + "," + h;
    }

    public static string[] ListWindows() {
        var results = new System.Collections.Generic.List<string>();
        EnumWindows((hwnd, param) => {
            if (!IsWindowVisible(hwnd)) return true;
            int length = GetWindowTextLength(hwnd);
            if (length == 0) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            results.Add(WindowJson(hwnd, pid));
            return true;
        }, IntPtr.Zero);
        return results.ToArray();
    }

    /// Bring a window to the front, and report honestly whether it worked.
    ///
    /// Windows refuses SetForegroundWindow from a process that is not already in the
    /// foreground. That refusal is how injected keystrokes end up in the wrong application,
    /// so lifting the lock is part of focusing rather than an optimisation, and the caller is
    /// told whether the window really is in front.
    public static string Focus(IntPtr hwnd) {
        if (GetForegroundWindow() == hwnd) return "focused " + hwnd.ToInt64() + " (already in front)";

        // Injecting an ALT press is the documented way to satisfy the foreground-lock rule:
        // the system then treats the following SetForegroundWindow as user-initiated.
        Send(new INPUT[] { Key(0x12, 0, 0), Key(0x12, 0, KEYEVENTF_KEYUP) });
        bool ok = SetForegroundWindow(hwnd);

        if (!ok) {
            // Fall back to sharing this thread's input state with the target's thread, which
            // makes the focus change permissible.
            IntPtr targetThread = GetWindowThreadProcessId(hwnd, IntPtr.Zero);
            IntPtr thisThread = GetCurrentThreadId();
            if (targetThread != IntPtr.Zero && AttachThreadInput(thisThread, targetThread, true)) {
                try {
                    BringWindowToTop(hwnd);
                    SetForegroundWindow(hwnd);
                    SetFocus(hwnd);
                } finally {
                    AttachThreadInput(thisThread, targetThread, false);
                }
            }
            ok = GetForegroundWindow() == hwnd;
        }

        return ok
            ? "focused " + hwnd.ToInt64()
            : "FAILED to focus " + hwnd.ToInt64() + " - input withheld, because injecting into whatever is in front would hit the wrong window";
    }

    /// Which top-level window owns a screen point.
    ///
    /// This is the guard synthetic input needs. Clicking at a coordinate without asking what
    /// is underneath is exactly how input lands in the wrong application, and that failure is
    /// invisible to the caller: nothing errors, something just gets clicked.
    public static string AtPoint(int x, int y) {
        POINT p; p.X = x; p.Y = y;
        IntPtr hwnd = WindowFromPoint(p);
        if (hwnd == IntPtr.Zero) return "{\"error\":\"no window at " + x + "," + y + "\"}";
        IntPtr top = GetAncestor(hwnd, 2); // GA_ROOT
        if (top == IntPtr.Zero) top = hwnd;
        uint pid; GetWindowThreadProcessId(top, out pid);
        return WindowJson(top, pid);
    }

    /// Assert that a point belongs to an expected window before anything is injected there.
    public static string GuardPoint(int x, int y, IntPtr expected) {
        POINT p; p.X = x; p.Y = y;
        IntPtr hwnd = WindowFromPoint(p);
        IntPtr top = hwnd == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hwnd, 2);
        if (top == IntPtr.Zero) top = hwnd;
        if (top != expected) {
            return "REFUSED: point " + x + "," + y + " belongs to window " + top.ToInt64() +
                   ", not the expected " + expected.ToInt64();
        }
        return "ok";
    }

    public static bool IsForeground(IntPtr hwnd) { return GetForegroundWindow() == hwnd; }
}
'@

Add-Type -TypeDefinition $signature -ReferencedAssemblies System.Drawing, System.Windows.Forms -ErrorAction Stop

function Write-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }

switch ($Action) {
  'screen' {
    Write-Result @{
      ok = $true
      width = [Desktop]::GetSystemMetrics(0)
      height = [Desktop]::GetSystemMetrics(1)
      virtualX = [Desktop]::GetSystemMetrics(76)
      virtualY = [Desktop]::GetSystemMetrics(77)
      virtualWidth = [Desktop]::GetSystemMetrics(78)
      virtualHeight = [Desktop]::GetSystemMetrics(79)
    }
  }

  'cursor' {
    $p = New-Object Desktop+POINT
    [void][Desktop]::GetCursorPos([ref]$p)
    Write-Result @{ ok = $true; x = $p.X; y = $p.Y }
  }

  'screenshot' {
    if (-not $Path) { throw 'screenshot needs -Path' }
    if ($Region) {
      $parts = $Region.Split(',')
      $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
    } elseif ($X -ne [int]::MinValue) {
      # A window handle was passed: capture exactly that window's frame, so the shot holds the
      # application and nothing of whatever happens to be stacked around it.
      $rect = [Desktop]::RectOf([IntPtr][long]$X)
      if ($rect -eq '') { throw "could not read the bounds of window $X" }
      $parts = $rect.Split(',')
      $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
    } else {
      $x = [Desktop]::GetSystemMetrics(76); $y = [Desktop]::GetSystemMetrics(77)
      $w = [Desktop]::GetSystemMetrics(78); $h = [Desktop]::GetSystemMetrics(79)
    }
    # A window partly off-screen would make CopyFromScreen fail or produce black edges.
    if ($w -le 0 -or $h -le 0) { throw "window has no area: ${w}x${h}" }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Result @{ ok = $true; path = $Path; x = $x; y = $y; width = $w; height = $h; bytes = (Get-Item $Path).Length }
  }

  'move' {
    if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'move needs -X and -Y' }
    $at = [Desktop]::MoveTo($X, $Y, $Duration)
    Write-Result @{ ok = $true; cursor = $at; requested = "$X,$Y" }
  }

  'click' {
    if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
      [void][Desktop]::MoveTo($X, $Y, $Duration)
    }
    $p = New-Object Desktop+POINT
    [void][Desktop]::GetCursorPos([ref]$p)
    $detail = [Desktop]::Click($Button, $Count)
    Write-Result @{ ok = $true; detail = $detail; at = "$($p.X),$($p.Y)" }
  }

  'scroll' {
    Write-Result @{ ok = $true; detail = [Desktop]::Scroll($Amount) }
  }

  'text' {
    if (-not $Text) { throw 'text needs -Text' }
    Write-Result @{ ok = $true; detail = [Desktop]::TypeText($Text) }
  }

  'key' {
    if (-not $Text) { throw 'key needs -Text, for example ^s or %{F4}' }
    Write-Result @{ ok = $true; detail = [Desktop]::SendChord($Text) }
  }

  'foreground' {
    Write-Output ([Desktop]::Foreground())
  }

  'atpoint' {
    if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'atpoint needs -X and -Y' }
    Write-Output ([Desktop]::AtPoint($X, $Y))
  }

  'guard' {
    if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'guard needs -X and -Y' }
    if ($Text -eq $null -or $Text -eq '') { throw 'guard needs -Text <expected window handle>' }
    Write-Output ([Desktop]::GuardPoint($X, $Y, [IntPtr][long]$Text))
  }

  'windows' {
    Write-Output ('[' + ([string]::Join(',', [Desktop]::ListWindows())) + ']')
  }

  'focus' {
    if ($X -eq [int]::MinValue) { throw 'focus needs -X <window handle>' }
    Write-Result @{ ok = $true; detail = [Desktop]::Focus([IntPtr]$X) }
  }

  default { throw "unknown action: $Action" }
}
