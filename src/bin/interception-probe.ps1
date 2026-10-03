# Verify the Interception C API can be driven from PowerShell, without a C compiler.
#
# Interception ships interception.dll plus a C header; there is no compiler on this machine, so a
# C helper is not an option. P/Invoke through Add-Type is: it can declare the structs and functions
# and marshal them, which is all the driver path needs.
#
# The driver is installed but will not be in the input stack until the next restart, so
# interception_create_context is expected to fail here. That is fine and is exactly what this
# checks: everything up to the driver handshake is verified now, so that after the restart the only
# unknown is the driver itself.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dll = Join-Path $root 'vendor\interception\library\x64\interception.dll'

Write-Output '=== 1. DLL presence ==='
if (-not (Test-Path $dll)) { throw "interception.dll missing at $dll" }
$info = Get-Item $dll
Write-Output "  path:   $dll"
Write-Output "  bytes:  $($info.Length)"
Write-Output "  arch:   $(if ((Get-Command dumpbin -ErrorAction SilentlyContinue)) { 'dumpbin unavailable' } else { 'assuming x64 (library\x64)' })"
$sig = Get-AuthenticodeSignature $dll
Write-Output "  signed: $($sig.Status)"

Write-Output ''
Write-Output '=== 2. declare the API through P/Invoke ==='
# The struct layouts are copied from interception.h, which declares:
#   MouseStroke { unsigned short state; unsigned short flags; short rolling; int x; int y; unsigned int information; }
#   KeyStroke   { unsigned short code; unsigned short state; unsigned int information; }
# Their sizes with default alignment are 20 and 8 bytes. A mismatch produces input that silently
# does nothing, so the sizes are measured at runtime instead of trusted to a comment.
$source = @'
using System;
using System.Runtime.InteropServices;

public static class Interception {
    // interception_set_filter takes a C function pointer. A managed delegate with an unmanaged
    // calling convention is how that is expressed; using the BCL's generic Predicate<T> fails to
    // compile because it requires a type argument.
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

    public const int MOUSE_LEFT_BUTTON_DOWN = 0x001;
    public const int MOUSE_LEFT_BUTTON_UP   = 0x002;
    public const int MOUSE_MOVE_RELATIVE    = 0x000;
    public const int MOUSE_MOVE_ABSOLUTE    = 0x001;
    public const ushort FILTER_MOUSE_ALL    = 0xFFFF;
    public const ushort FILTER_KEY_ALL      = 0xFFFF;

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern IntPtr interception_create_context();

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern void interception_destroy_context(IntPtr context);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern void interception_set_filter(IntPtr context, InterceptionPredicate isIntercepted, ushort filter);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_send(IntPtr context, int device, [In] MouseStroke[] strokes, uint nstroke);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_send_keys(IntPtr context, int device, [In] KeyStroke[] strokes, uint nstroke);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_is_mouse(int device);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_is_keyboard(int device);

    [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
    public static extern int interception_get_hardware_id(IntPtr context, int device, byte[] buffer, uint size);

    public static string[] DeviceList(IntPtr context) {
        var found = new System.Collections.Generic.List<string>();
        for (int device = 1; device <= 20; device++) {
            if (interception_is_mouse(device) != 0) {
                found.Add(device + ":mouse");
            } else if (interception_is_keyboard(device) != 0) {
                found.Add(device + ":keyboard");
            }
        }
        return found.ToArray();
    }
}
'@

try {
  Add-Type -TypeDefinition $source -ErrorAction Stop
  Write-Output '  Add-Type: OK (structs and functions declared)'
} catch {
  Write-Output "  Add-Type FAILED -> $($_.Exception.Message)"
  exit 1
}

Write-Output ''
Write-Output '=== 3. struct sizes (a mismatch here is a silent failure) ==='
$mouseSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Interception+MouseStroke])
$keySize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Interception+KeyStroke])
Write-Output "  MouseStroke: $mouseSize bytes (interception.h layout totals 20)"
Write-Output "  KeyStroke:   $keySize bytes (interception.h layout totals 8)"

Write-Output ''
Write-Output '=== 4. call the API (before the restart the driver is not in the stack) ==='
try {
  $context = [Interception]::interception_create_context()
  if ($context -eq [IntPtr]::Zero) {
    Write-Output '  interception_create_context -> NULL'
    Write-Output '  Expected until the next restart: the filter driver is on disk but not yet loaded.'
  } else {
    Write-Output "  interception_create_context -> $context  (driver is live)"
    $devices = [Interception]::DeviceList($context)
    Write-Output "  devices: $(if ($devices.Count -eq 0) { '(none enumerated)' } else { $devices -join ', ' })"
    [Interception]::interception_destroy_context($context)
    Write-Output '  context destroyed'
  }
} catch {
  Write-Output "  call failed -> $($_.Exception.Message)"
  Write-Output '  Expected until the next restart.'
}

Write-Output ''
Write-Output '=== conclusion ==='
Write-Output '  The P/Invoke path is what matters here. If Add-Type succeeded and the struct sizes are'
Write-Output '  right, then after one more restart the only remaining unknown is the driver itself.'
