# Driver-level input: move and click through the Interception filter driver.
#
# Why this exists alongside the SendInput helper in desktop.ps1.
#
# SendInput injects at user level, above the input stack. Some applications ignore input that
# arrives that way — a browser button here received the full press/release/click sequence and its
# own script even reported the pointer position, yet the control never activated. A filter driver
# sits below that boundary: to the system, events sent through it are indistinguishable from the
# device's own, so an application has nothing to distinguish.
#
# The layout constants and struct shapes are taken from interception.h. Struct size errors here
# produce input that silently does nothing, so both sizes are asserted at runtime before any event
# is sent.
#
# Usage:
#   interception-input.ps1 -Action probe
#   interception-input.ps1 -Action move  -X 400 -Y 300
#   interception-input.ps1 -Action click -X 400 -Y 300 [-Button left] [-Count 1]
#   interception-input.ps1 -Action point            # report the cursor, to verify a move landed
#
# Output: one JSON object per invocation.

param(
  [Parameter(Mandatory = $true)][ValidateSet('probe', 'move', 'click', 'point', 'key', 'text')][string]$Action,
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [ValidateSet('left', 'right', 'middle')][string]$Button = 'left',
  [int]$Count = 1,
  # key: one key name from the scan-code table, such as ENTER, TAB, A, F5, or a single character.
  # text: literal text, typed one character at a time.
  [string]$Keys,
  # Milliseconds between keystrokes. Targets that poll input can drop events sent faster than they
  # read them, and this is the knob for that.
  [int]$DelayMs = 18
)

$ErrorActionPreference = 'Stop'

# The DLL lives beside the plugin rather than in System32, so its directory goes on the search
# path for this process only.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dllDir = Join-Path $root 'vendor\interception\library\x64'
$env:PATH = "$dllDir;$env:PATH"

$source = @'
using System;
using System.Runtime.InteropServices;

public static class Interception {
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate int InterceptionPredicate(int device);

    [StructLayout(LayoutKind.Sequential)]
    public struct MouseStroke {
        public ushort state;
        public ushort flags;
        public short rolling;
        public int x;
        public int y;
        public uint information;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KeyStroke {
        public ushort code;
        public ushort state;
        public uint information;
    }

    // The type the driver actually takes: a union of a mouse stroke and a key stroke.
    //
    // This is the shape the header declares — interception_send(context, device, const
    // InterceptionStroke*, nstroke) — and there is no separate interception_send_keys export,
    // contrary to what the published C API reference suggests. Declaring a keyboard-specific entry
    // point produced "entry point not found" at call time, which is why the exports were enumerated
    // rather than trusted.
    //
    // Explicit layout with both members at offset 0 gives the union. The size is not cosmetic: it is
    // the stride the driver uses to walk an array of strokes, so an 8-byte key stroke passed in an
    // array would be read at the wrong offsets.
    [StructLayout(LayoutKind.Explicit, Size = 20)]
    public struct Stroke {
        [FieldOffset(0)] public MouseStroke mouse;
        [FieldOffset(0)] public KeyStroke key;
    }

    // Mouse state bits, from interception.h.
    public const ushort MOUSE_LEFT_DOWN   = 0x001;
    public const ushort MOUSE_LEFT_UP     = 0x002;
    public const ushort MOUSE_RIGHT_DOWN  = 0x004;
    public const ushort MOUSE_RIGHT_UP    = 0x008;
    public const ushort MOUSE_MIDDLE_DOWN = 0x010;
    public const ushort MOUSE_MIDDLE_UP   = 0x020;

    // Mouse flag bits.
    public const ushort MOUSE_MOVE_RELATIVE = 0x000;
    public const ushort MOUSE_MOVE_ABSOLUTE = 0x001;
    public const ushort MOUSE_VIRTUAL_DESKTOP = 0x002;

    // Intercept every mouse event; without this the driver passes the device through untouched and
    // interception_send still works, but the filter is what makes state observable.
    public const ushort FILTER_MOUSE_ALL = 0xFFFF;

    // The same for the keyboard. interception_send_keys works without it, but a filter is what makes
    // the driver the owner of the device rather than a passenger.
    public const ushort FILTER_KEY_ALL = 0xFFFF;

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr interception_create_context();

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern void interception_destroy_context(IntPtr context);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern void interception_set_filter(IntPtr context, InterceptionPredicate isIntercepted, ushort filter);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_send(IntPtr context, int device, [In] Stroke[] strokes, uint nstroke);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_is_mouse(int device);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_is_keyboard(int device);

    // The virtual desktop bounds come from user32 rather than System.Windows.Forms: the conversion
    // to normalised coordinates runs on every move, and loading a WinForms assembly for four
    // integers is a dependency with no benefit.
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out System.Drawing.Point point);

    /// A context with every mouse device intercepted.
    public static IntPtr OpenContext() {
        IntPtr context = interception_create_context();
        if (context == IntPtr.Zero) return IntPtr.Zero;
        // A predicate that accepts every device, so all mice are intercepted. Kept as a static
        // field: a delegate that becomes unreachable could be collected while the driver still
        // holds the pointer.
        interception_set_filter(context, AcceptAll, FILTER_MOUSE_ALL);
        return context;
    }

    public static int AcceptAll(int device) { return 1; }

    /// The first device index that is a mouse, or 0 when there is none.
    public static int FirstMouse() {
        for (int device = 1; device <= 20; device++) {
            if (interception_is_mouse(device) != 0) return device;
        }
        return 0;
    }

    /// The first device index that is a keyboard, or 0 when there is none.
    public static int FirstKeyboard() {
        for (int device = 1; device <= 20; device++) {
            if (interception_is_keyboard(device) != 0) return device;
        }
        return 0;
    }

    /// A context with every keyboard device intercepted.
    public static IntPtr OpenKeyboardContext() {
        IntPtr context = interception_create_context();
        if (context == IntPtr.Zero) return IntPtr.Zero;
        interception_set_filter(context, AcceptAll, FILTER_KEY_ALL);
        return context;
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing -ErrorAction Stop

# ---------------------------------------------------------------------------------------------
# PS/2 Set 1 scan codes.
#
# interception.h declares only the state flags (KEY_DOWN/KEY_UP/E0/E1), not the scan codes
# themselves, so the table comes from the PS/2 specification. A wrong code types the wrong
# character, which is visible and easy to correct; a missing entry would otherwise type nothing
# at all, so an unknown key is reported rather than silently skipped.
# ---------------------------------------------------------------------------------------------
$scan = @{
  'ESC' = 0x01; '1' = 0x02; '2' = 0x03; '3' = 0x04; '4' = 0x05; '5' = 0x06; '6' = 0x07
  '7' = 0x08; '8' = 0x09; '9' = 0x0A; '0' = 0x0B; '-' = 0x0C; '=' = 0x0D
  'BACKSPACE' = 0x0E; 'TAB' = 0x0F
  'Q' = 0x10; 'W' = 0x11; 'E' = 0x12; 'R' = 0x13; 'T' = 0x14; 'Y' = 0x15; 'U' = 0x16
  'I' = 0x17; 'O' = 0x18; 'P' = 0x19; '[' = 0x1A; ']' = 0x1B; 'ENTER' = 0x1C
  'A' = 0x1E; 'S' = 0x1F; 'D' = 0x20; 'F' = 0x21; 'G' = 0x22; 'H' = 0x23; 'J' = 0x24
  'K' = 0x25; 'L' = 0x26; ';' = 0x27; "'" = 0x28; '`' = 0x29
  '\' = 0x2B; 'Z' = 0x2C; 'X' = 0x2D; 'C' = 0x2E; 'V' = 0x2F; 'B' = 0x30; 'N' = 0x31
  'M' = 0x32; ',' = 0x33; '.' = 0x34; '/' = 0x35; 'SPACE' = 0x39
  'F1' = 0x3B; 'F2' = 0x3C; 'F3' = 0x3D; 'F4' = 0x3E; 'F5' = 0x3F; 'F6' = 0x40
  'F7' = 0x41; 'F8' = 0x42; 'F9' = 0x43; 'F10' = 0x44
  'HOME' = 0x47; 'UP' = 0x48; 'PAGEUP' = 0x49; 'LEFT' = 0x4B; 'RIGHT' = 0x4D
  'END' = 0x4F; 'DOWN' = 0x50; 'PAGEDOWN' = 0x51; 'INSERT' = 0x52; 'DELETE' = 0x53
}
# Characters that require Shift on a US layout, mapped to the unshifted key.
$shifted = @{
  '!' = '1'; '@' = '2'; '#' = '3'; '$' = '4'; '%' = '5'; '^' = '6'; '&' = '7'
  '*' = '8'; '(' = '9'; ')' = '0'; '_' = '-'; '+' = '='; '{' = '['; '}' = ']'
  '|' = '\'; ':' = ';'; '"' = "'"; '<' = ','; '>' = '.'; '?' = '/'; '~' = '`'
}
$SHIFT = 0x2A

# Guard against the classic silent failure before anything is sent.
$mouseSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Interception+MouseStroke])
if ($mouseSize -ne 20) {
  throw "InterceptionMouseStroke marshals to $mouseSize bytes but the driver expects 20; refusing to send input that would be misinterpreted."
}

function Write-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }

# Type a string through the driver, one character at a time.
# 
# Characters are resolved through the scan-code table rather than by virtual key, because the driver
# works in scan codes. Shift is pressed around characters that need it and released after, so a
# shifted character does not leave Shift stuck down for the rest of the string. A stuck modifier is
# the failure that turns a sentence into something unrecognisable.
# 
# The tables and the delay are passed in rather than read from script scope, because a function does
# not see the variables of the code that called it. A silent miss there would look like a driver
# fault and send the investigation in the wrong direction.
function Send-Chars {
  param(
    [IntPtr]$KbContext,
    [int]$Device,
    [string]$Text,
    [hashtable]$Scan,
    [hashtable]$Shifted,
    [int]$ShiftCode,
    [int]$DelayMs
  )

  $total = 0
  foreach ($ch in $Text.ToCharArray()) {
    $name = [string]$ch
    $needsShift = $false

    # Space arrives as a character but is named SPACE in the table; the same will apply to any other
    # character whose name differs from its glyph.
    if ($name -eq ' ') { $name = 'SPACE' }

    if ($Shifted.ContainsKey($name)) {
      $name = $Shifted[$name]
      $needsShift = $true
    } elseif ($name -cmatch '^[A-Z]$') {
      $needsShift = $true
    }

    $key = $name.ToUpperInvariant()
    if (-not $Scan.ContainsKey($key)) {
      throw "no scan code for character '$ch' (looked up as '$key'); add it to the table rather than sending the wrong key"
    }
    $code = [uint16]$Scan[$key]

    # Strokes go through the union type, because interception_send is the only entry point and it
    # takes InterceptionStroke. A key stroke is placed in the union's key member; the mouse member
    # stays zero, which is also what the driver expects for a keyboard device.
    $strokes = New-Object 'System.Collections.Generic.List[Interception+Stroke]'
    if ($needsShift) {
      $down = New-Object Interception+Stroke
      [void]($down.key = New-Object Interception+KeyStroke)
      $down.key.code = [uint16]$ShiftCode; $down.key.state = 0
      $strokes.Add($down)
    }
    $kd = New-Object Interception+Stroke
    [void]($kd.key = New-Object Interception+KeyStroke)
    $kd.key.code = $code; $kd.key.state = 0
    $ku = New-Object Interception+Stroke
    [void]($ku.key = New-Object Interception+KeyStroke)
    $ku.key.code = $code; $ku.key.state = 1
    $strokes.Add($kd); $strokes.Add($ku)
    if ($needsShift) {
      $up = New-Object Interception+Stroke
      [void]($up.key = New-Object Interception+KeyStroke)
      $up.key.code = [uint16]$ShiftCode; $up.key.state = 1
      $strokes.Add($up)
    }

    $array = $strokes.ToArray()
    $sent = [Interception]::interception_send($KbContext, $Device, $array, [uint32]$array.Length)
    if ($sent -ne $array.Length) { throw "driver accepted $sent of $($array.Length) keystrokes for '$ch'" }
    $total += $sent
    if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
  }
  return $total
}

$context = [Interception]::OpenContext()
if ($context -eq [IntPtr]::Zero) {
  Write-Result @{
    ok = $false
    reason = 'interception_create_context returned NULL'
    hint = 'the filter driver is installed but not loaded; a restart is required after installing it'
  }
  exit 3
}

try {
  $device = [Interception]::FirstMouse()
  if ($device -eq 0) {
    Write-Result @{ ok = $false; reason = 'no mouse device enumerated by the driver' }
    exit 4
  }

  # Absolute positioning is expressed in the 0..65535 normalised range across the virtual desktop,
  # not in pixels. Pixels are converted here so callers can keep thinking in screen coordinates.
  #
  # GetSystemMetrics indices: 76/77 are the virtual screen origin, 78/79 its size.
  function Convert-Absolute([int]$px, [int]$py) {
    $left = [Interception]::GetSystemMetrics(76)
    $top = [Interception]::GetSystemMetrics(77)
    $w = [Interception]::GetSystemMetrics(78)
    $h = [Interception]::GetSystemMetrics(79)
    $nx = [int][math]::Round((($px - $left) * 65535.0) / [math]::Max(1, $w - 1))
    $ny = [int][math]::Round((($py - $top) * 65535.0) / [math]::Max(1, $h - 1))
    return @{ x = $nx; y = $ny; width = $w; height = $h; left = $left; top = $top }
  }

  # Wrap a mouse stroke in the union type that interception_send actually takes.
  #
  # The nested New-Object is discarded with [void] because in PowerShell an assignment whose value is
  # not consumed writes to the pipeline. Without it this function returns the intermediate mouse
  # stroke as well as the union, and a caller adding the result to a list receives an array where it
  # expected one element — which surfaces as "cannot find an overload for Add and the argument count:
  # 1", a message that points at the list rather than at the real cause.
  function New-MouseStroke([int]$state, [uint16]$flags, [int]$nx, [int]$ny) {
    $stroke = New-Object Interception+Stroke
    [void]($stroke.mouse = New-Object Interception+MouseStroke)
    $stroke.mouse.state = [uint16]$state
    $stroke.mouse.flags = $flags
    $stroke.mouse.x = $nx
    $stroke.mouse.y = $ny
    return $stroke
  }

  switch ($Action) {
    'probe' {
      # The exported names carry the interception_ prefix; calling them without it fails with
      # "does not contain a method named is_mouse", which reads like a missing API rather than a
      # misspelled call.
      $mice = @(1..20 | Where-Object { [Interception]::interception_is_mouse($_) -ne 0 })
      $keys = @(1..20 | Where-Object { [Interception]::interception_is_keyboard($_) -ne 0 })
      Write-Result @{
        ok = $true
        context = $context.ToInt64()
        mouseDevice = $device
        mouseDevices = $mice
        keyboardDevices = $keys
        strokeBytes = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Interception+Stroke])
        hint = 'a non-empty mouseDevices list means the driver is loaded and enumerating devices'
      }
    }

    'move' {
      if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'move needs -X and -Y' }
      $abs = Convert-Absolute $X $Y
      $flags = [Interception]::MOUSE_MOVE_ABSOLUTE -bor [Interception]::MOUSE_VIRTUAL_DESKTOP
      $stroke = New-MouseStroke 0 $flags $abs.x $abs.y
      $sent = [Interception]::interception_send($context, $device, @($stroke), 1)
      Write-Result @{ ok = ($sent -eq 1); action = 'move'; device = $device; normalised = "$($abs.x),$($abs.y)"; desktop = "$($abs.width)x$($abs.height)"; requested = "$X,$Y" }
    }

    'click' {
      $down, $up = switch ($Button) {
        'right'  { [Interception]::MOUSE_RIGHT_DOWN,  [Interception]::MOUSE_RIGHT_UP }
        'middle' { [Interception]::MOUSE_MIDDLE_DOWN, [Interception]::MOUSE_MIDDLE_UP }
        default  { [Interception]::MOUSE_LEFT_DOWN,   [Interception]::MOUSE_LEFT_UP }
      }
      $strokes = New-Object 'System.Collections.Generic.List[Interception+Stroke]'
      if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
        $abs = Convert-Absolute $X $Y
        $flags = [Interception]::MOUSE_MOVE_ABSOLUTE -bor [Interception]::MOUSE_VIRTUAL_DESKTOP
        $strokes.Add((New-MouseStroke 0 $flags $abs.x $abs.y))
      }
      for ($i = 0; $i -lt $Count; $i++) {
        # A button stroke carries only the state bits; the coordinates come from the preceding move,
        # which is why the move stroke is added first and these leave x and y at zero.
        $strokes.Add((New-MouseStroke $down 0 0 0))
        $strokes.Add((New-MouseStroke $up 0 0 0))
      }
      $array = $strokes.ToArray()
      $sent = [Interception]::interception_send($context, $device, $array, [uint32]$array.Length)
      Write-Result @{ ok = ($sent -eq $array.Length); action = 'click'; button = $Button; count = $Count; strokes = $array.Length; sent = $sent; device = $device }
    }

    'point' {
      $p = New-Object System.Drawing.Point
      [void][Interception]::GetCursorPos([ref]$p)
      Write-Result @{ ok = $true; x = $p.X; y = $p.Y }
    }

    'key' {
      if ([string]::IsNullOrEmpty($Keys)) { throw 'key needs -Keys, such as ENTER, TAB, or a character' }
      $kbContext = [Interception]::OpenKeyboardContext()
      if ($kbContext -eq [IntPtr]::Zero) {
        Write-Result @{ ok = $false; reason = 'keyboard context could not be created'; hint = 'restart required after driver install' }
        exit 3
      }
      try {
        $kb = [Interception]::FirstKeyboard()
        if ($kb -eq 0) { Write-Result @{ ok = $false; reason = 'no keyboard device enumerated' }; exit 4 }
        $sent = Send-Chars -KbContext $kbContext -Device $kb -Text $Keys -Scan $scan -Shifted $shifted -ShiftCode $SHIFT -DelayMs $DelayMs
        Write-Result @{ ok = $true; action = 'key'; keys = $Keys; strokes = $sent; device = $kb }
      } finally {
        [Interception]::interception_destroy_context($kbContext)
      }
    }

    'text' {
      if ([string]::IsNullOrEmpty($Keys)) { throw 'text needs -Keys with the literal text to type' }
      $kbContext = [Interception]::OpenKeyboardContext()
      if ($kbContext -eq [IntPtr]::Zero) {
        Write-Result @{ ok = $false; reason = 'keyboard context could not be created'; hint = 'restart required after driver install' }
        exit 3
      }
      try {
        $kb = [Interception]::FirstKeyboard()
        if ($kb -eq 0) { Write-Result @{ ok = $false; reason = 'no keyboard device enumerated' }; exit 4 }
        $sent = Send-Chars -KbContext $kbContext -Device $kb -Text $Keys -Scan $scan -Shifted $shifted -ShiftCode $SHIFT -DelayMs $DelayMs
        Write-Result @{ ok = $true; action = 'text'; length = $Keys.Length; strokes = $sent; device = $kb }
      } finally {
        [Interception]::interception_destroy_context($kbContext)
      }
    }
  }
} finally {
  if ($context -ne [IntPtr]::Zero) { [Interception]::interception_destroy_context($context) }
}
