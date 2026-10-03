# list-interfaces.ps1 — enumerate every device interface the driver registers, for both GUIDs.
#
# "Which device am I talking to" turned out to be the question that mattered: the client opens the first
# matching interface, and after several install cycles a device node can be left behind that still enumerates
# and still accepts reports while producing no input, because the virtual HID device beneath it is gone. The
# client then talks to that one, every call succeeds, and nothing happens.
#
# This prints every interface, in the order the client would see them, so the count and the order are visible
# instead of assumed.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Setup {
    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVICE_INTERFACE_DATA {
        public int cbSize;
        public Guid InterfaceClassGuid;
        public int Flags;
        public IntPtr Reserved;
    }
    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr hwndParent, int flags);
    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid guid, int index, ref SP_DEVICE_INTERFACE_DATA data);
    [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref SP_DEVICE_INTERFACE_DATA data, IntPtr detail, int detailSize, out int required, IntPtr info);
    [DllImport("setupapi.dll", SetLastError = true)]
    public static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr CreateFile(string name, int access, int share, IntPtr security, int disposition, int flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

$DIGCF_PRESENT = 0x2
$DIGCF_DEVICEINTERFACE = 0x10
$GENERIC_READ = -2147483648
$GENERIC_WRITE = 1073741824
$SHARE = 3
$OPEN_EXISTING = 3

$guids = [ordered]@{
  'VHFKEY  ' = '6b2f9a41-3c7d-4e58-9f21-8a4c1d5e7b30'
  'VHFMOUSE' = '7c3e0b52-4d8e-4f69-a032-9b5d2e6f8c41'
}

foreach ($name in $guids.Keys) {
  $guid = [Guid]$guids[$name]
  $set = [Setup]::SetupDiGetClassDevs([ref]$guid, [IntPtr]::Zero, [IntPtr]::Zero, ($DIGCF_PRESENT -bor $DIGCF_DEVICEINTERFACE))
  Write-Output "$name :"
  if ($set -eq [IntPtr]::new(-1)) { Write-Output '  SetupDiGetClassDevs failed'; continue }

  $index = 0
  $found = 0
  while ($true) {
    $data = New-Object Setup+SP_DEVICE_INTERFACE_DATA
    $data.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($data)
    if (-not [Setup]::SetupDiEnumDeviceInterfaces($set, [IntPtr]::Zero, [ref]$guid, $index, [ref]$data)) { break }

    $required = 0
    [void][Setup]::SetupDiGetDeviceInterfaceDetail($set, [ref]$data, [IntPtr]::Zero, 0, [ref]$required, [IntPtr]::Zero)
    if ($required -le 0) { $index++; continue }

    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($required)
    try {
      [System.Runtime.InteropServices.Marshal]::WriteInt32($buffer, 8)
      if ([Setup]::SetupDiGetDeviceInterfaceDetail($set, [ref]$data, $buffer, $required, [ref]$required, [IntPtr]::Zero)) {
        $path = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([IntPtr]::Add($buffer, 4))
        # Whether the interface can actually be opened is what the client depends on, so it is reported too.
        $handle = [Setup]::CreateFile($path, ($GENERIC_READ -bor $GENERIC_WRITE), $SHARE, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
        $openable = $handle -ne [IntPtr]::new(-1)
        if ($openable) { [void][Setup]::CloseHandle($handle) }
        Write-Output ("  [{0}] openable={1}  {2}" -f $index, $openable, $path)
        $found++
      }
    } finally { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    $index++
  }
  Write-Output "  total: $found   (the client opens index 0)"
  [void][Setup]::SetupDiDestroyDeviceInfoList($set)
  Write-Output ''
}
