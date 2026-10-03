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
  [Parameter(Mandatory = $true)][ValidateSet('probe', 'move', 'click', 'point')][string]$Action,
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  [ValidateSet('left', 'right', 'middle')][string]$Button = 'left',
  [int]$Count = 1
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

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr interception_create_context();

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern void interception_destroy_context(IntPtr context);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern void interception_set_filter(IntPtr context, InterceptionPredicate isIntercepted, ushort filter);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_send(IntPtr context, int device, [In] MouseStroke[] strokes, uint nstroke);

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
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing -ErrorAction Stop

# Guard against the classic silent failure before anything is sent.
$mouseSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Interception+MouseStroke])
if ($mouseSize -ne 20) {
  throw "InterceptionMouseStroke marshals to $mouseSize bytes but the driver expects 20; refusing to send input that would be misinterpreted."
}

function Write-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5) }

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
        mouseStrokeBytes = $mouseSize
        hint = 'a non-empty mouseDevices list means the driver is loaded and enumerating devices'
      }
    }

    'move' {
      if ($X -eq [int]::MinValue -or $Y -eq [int]::MinValue) { throw 'move needs -X and -Y' }
      $abs = Convert-Absolute $X $Y
      $stroke = New-Object Interception+MouseStroke
      $stroke.flags = [Interception]::MOUSE_MOVE_ABSOLUTE -bor [Interception]::MOUSE_VIRTUAL_DESKTOP
      $stroke.x = $abs.x
      $stroke.y = $abs.y
      $sent = [Interception]::interception_send($context, $device, @($stroke), 1)
      Write-Result @{ ok = ($sent -eq 1); action = 'move'; device = $device; normalised = "$($abs.x),$($abs.y)"; desktop = "$($abs.width)x$($abs.height)"; requested = "$X,$Y" }
    }

    'click' {
      $down, $up = switch ($Button) {
        'right'  { [Interception]::MOUSE_RIGHT_DOWN,  [Interception]::MOUSE_RIGHT_UP }
        'middle' { [Interception]::MOUSE_MIDDLE_DOWN, [Interception]::MOUSE_MIDDLE_UP }
        default  { [Interception]::MOUSE_LEFT_DOWN,   [Interception]::MOUSE_LEFT_UP }
      }
      $strokes = New-Object 'System.Collections.Generic.List[Interception+MouseStroke]'
      if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
        $abs = Convert-Absolute $X $Y
        $move = New-Object Interception+MouseStroke
        $move.flags = [Interception]::MOUSE_MOVE_ABSOLUTE -bor [Interception]::MOUSE_VIRTUAL_DESKTOP
        $move.x = $abs.x
        $move.y = $abs.y
        $strokes.Add($move)
      }
      for ($i = 0; $i -lt $Count; $i++) {
        $d = New-Object Interception+MouseStroke; $d.state = $down; $strokes.Add($d)
        $u = New-Object Interception+MouseStroke; $u.state = $up;   $strokes.Add($u)
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
  }
} finally {
  if ($context -ne [IntPtr]::Zero) { [Interception]::interception_destroy_context($context) }
}
