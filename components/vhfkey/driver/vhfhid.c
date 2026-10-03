/*
 * vhfhid.c - virtual HID keyboard and mouse, presented through the Virtual HID Framework.
 *
 * One device node creates one virtual HID device, and which one is decided by the hardware ID the node was
 * enumerated with: root\vhfhidkey gives a keyboard, root\vhfhidmouse gives a mouse. The driver binary and
 * the service are shared; the nodes are separate.
 *
 * That structure is deliberate, and it replaces an earlier design. The first version created both virtual
 * devices from a single device object, holding both sets of state in one allocated context, and it crashed
 * with an access violation inside the framework's ready callback: the device pointer loaded from the stack
 * was not a pointer at all, and it had been usable two instructions earlier, in a memcpy reading through the
 * same register. Rather than keep guessing at why, this removes the sharing that made such a failure
 * possible - one virtual device, one device object, one context, and no pointer arithmetic into a parent
 * structure.
 *
 * Flow, in the order the framework drives it:
 *
 *   1. VHF is told about the device, with the report descriptor that defines it.
 *   2. The HID stack asks for a report. VHF answers by calling the ready callback, which says "I can take
 *      one report now".
 *   3. User mode hands over a report through this device's IOCTL. If VHF is waiting, the report goes through
 *      with VhfReadReportSubmit and becomes input; if not, it waits here until it is.
 *
 * The read queue belongs to VHF, not to this driver.
 */

#define INITGUID

#include <ntddk.h>
#include <wdf.h>
#include <hidport.h>
#include <vhf.h>
#include <initguid.h>

#include "vhfhid.h"

/*
 * The Virtual HID Framework declarations come from vhf.h. Hand-declaring VHF_CONFIG was tried first and
 * would have been a trap: the real structure differs in most fields from what the published prose suggests,
 * and VhfCreate reads it by offset, so a wrong layout compiles cleanly and then misbehaves at run time.
 */

/*
 * The keyboard report descriptor: a standard keyboard, eight-byte reports.
 *
 * It declares one modifier byte (eight one-bit usages), one reserved byte, and six key slots covering the
 * full usage range - the boot-protocol layout Windows has understood since before USB existed.
 */
static const UCHAR g_KeyboardReportDescriptor[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x06,        // Usage (Keyboard)
    0xA1, 0x01,        // Collection (Application)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0xE0,        //   Usage Minimum (Left Control)
    0x29, 0xE7,        //   Usage Maximum (Right GUI)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x75, 0x01,        //   Report Size (1)
    0x95, 0x08,        //   Report Count (8)
    0x81, 0x02,        //   Input (Data, Variable, Absolute)  -> modifier byte
    0x95, 0x01,        //   Report Count (1)
    0x75, 0x08,        //   Report Size (8)
    0x81, 0x01,        //   Input (Constant)                  -> reserved byte
    0x95, 0x06,        //   Report Count (6)
    0x75, 0x08,        //   Report Size (8)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x65,        //   Logical Maximum (101)
    0x05, 0x07,        //   Usage Page (Keyboard/Keypad)
    0x19, 0x00,        //   Usage Minimum (0)
    0x29, 0x65,        //   Usage Maximum (101)
    0x81, 0x00,        //   Input (Data, Array)               -> six key slots
    0xC0               // End Collection
};

/*
 * The mouse report descriptor: a three-button mouse with absolute X and Y and a wheel.
 *
 * Six bytes, and the client builds its reports to match - read the two together when changing either:
 *
 *   byte 0       three button bits, then five bits of padding to reach the byte boundary
 *   bytes 1-2    X, absolute, 16-bit little-endian, 0..32767
 *   bytes 3-4    Y, absolute, 16-bit little-endian, 0..32767
 *   byte 5       vertical wheel, relative, signed
 *
 * The padding is not decoration. Without it the axes would begin mid-byte and every following field would be
 * offset by five bits, which the HID parser would reject as a report that does not match its descriptor.
 */
static const UCHAR g_MouseReportDescriptor[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x02,        // Usage (Mouse)
    0xA1, 0x01,        // Collection (Application)
    0x09, 0x01,        //   Usage (Pointer)
    0xA1, 0x00,        //   Collection (Physical)
    0x05, 0x09,        //     Usage Page (Button)
    0x19, 0x01,        //     Usage Minimum (Button 1)
    0x29, 0x03,        //     Usage Maximum (Button 3)
    0x15, 0x00,        //     Logical Minimum (0)
    0x25, 0x01,        //     Logical Maximum (1)
    0x95, 0x03,        //     Report Count (3)
    0x75, 0x01,        //     Report Size (1)
    0x81, 0x02,        //     Input (Data, Variable, Absolute)  -> 3 button bits
    0x95, 0x01,        //     Report Count (1)
    0x75, 0x05,        //     Report Size (5)
    0x81, 0x01,        //     Input (Constant)                  -> padding to the byte boundary
    0x05, 0x01,        //     Usage Page (Generic Desktop)
    0x09, 0x30,        //     Usage (X)
    0x09, 0x31,        //     Usage (Y)
    0x16, 0x00, 0x00,  //     Logical Minimum (0)
    0x26, 0xFF, 0x7F,  //     Logical Maximum (32767)
    0x75, 0x10,        //     Report Size (16)
    0x95, 0x02,        //     Report Count (2)
    0x81, 0x02,        //     Input (Data, Variable, Absolute)  -> X and Y, 2 bytes each
    0x09, 0x38,        //     Usage (Wheel)
    0x15, 0x81,        //     Logical Minimum (-127)
    0x25, 0x7F,        //     Logical Maximum (127)
    0x75, 0x08,        //     Report Size (8)
    0x95, 0x01,        //     Report Count (1)
    0x81, 0x06,        //     Input (Data, Variable, Relative)  -> vertical wheel
    0xC0,              //   End Collection
    0xC0               // End Collection
};

/*
 * The largest report either device produces, used as the size of the holding buffer.
 *
 * The buffer is deliberately larger than any report needs to be. A buffer sized exactly to the report is the
 * kind of thing that turns a length mistake into silent memory corruption, and the field it would corrupt
 * sits immediately after it.
 */
#define VHFHID_MAX_REPORT 16

/*
 * Per-device state. One of these per device node, because a node creates exactly one virtual device.
 */
/*
 * The holding buffer must be able to contain either report. Checked at compile time rather than trusted,
 * because the failure mode of getting it wrong is a stack overflow that surfaces somewhere else entirely.
 */
typedef char VHFHID_REPORT_FITS[
    (VHFKEY_REPORT_SIZE <= VHFHID_MAX_REPORT && VHFMOUSE_REPORT_SIZE <= VHFHID_MAX_REPORT) ? 1 : -1];

typedef struct _VHFDEVICE {
    VHFHANDLE    VhfHandle;
    WDFWAITLOCK  ReportLock;
    UCHAR        PendingReport[VHFHID_MAX_REPORT];
    ULONG        ReportLength;
    BOOLEAN      HasPendingReport;
    BOOLEAN      VhfReadyForReport;

} VHFDEVICE, *PVHFDEVICE;

typedef struct _VHFHID_CONTEXT {
    WDFDEVICE    Device;
    BOOLEAN      IsMouse;
    ULONG        IoControlCode;
    VHFDEVICE    Virtual;
} VHFHID_CONTEXT, *PVHFHID_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(VHFHID_CONTEXT, VhfHidGetContext)

DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD VhfHidEvtDeviceAdd;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL VhfHidEvtIoDeviceControl;
EVT_WDF_DEVICE_CONTEXT_CLEANUP VhfHidEvtDeviceContextCleanup;
EVT_VHF_READY_FOR_NEXT_READ_REPORT VhfHidEvtReadyForNextRead;
EVT_VHF_CLEANUP VhfHidEvtVhfCleanup;


static VOID
VhfHidTrySubmit(_In_ PVHFDEVICE Device)
{
    UCHAR report[VHFHID_MAX_REPORT];
    ULONG length = 0;
    BOOLEAN submit = FALSE;
    VHFHANDLE handle = NULL;
    HID_XFER_PACKET packet;

    if (Device == NULL) {
        return;
    }

    WdfWaitLockAcquire(Device->ReportLock, NULL);

    if (Device->HasPendingReport && Device->VhfReadyForReport && Device->VhfHandle != NULL) {
        ULONG pending = Device->ReportLength;
        if (pending > 0 && pending <= sizeof(report)) {
            RtlCopyMemory(report, Device->PendingReport, pending);
            length = pending;
            handle = Device->VhfHandle;
            submit = TRUE;
        }
        Device->HasPendingReport = FALSE;
        Device->VhfReadyForReport = FALSE;
    }

    WdfWaitLockRelease(Device->ReportLock);

    if (!submit) {
        return;
    }

    packet.reportBuffer = report;
    packet.reportBufferLen = length;
    packet.reportId = 0;

    /*
     * The submission itself. Without it the report dies in a local buffer, and nothing above reports a
     * failure: the IOCTL returns STATUS_SUCCESS, the device enumerates, and kbdhid and mouhid bind. The only
     * symptom is that no input is ever produced. The lock is released before this call because it can
     * re-enter the driver.
     */
    (VOID)VhfReadReportSubmit(handle, &packet);
}

static VOID
VhfHidEvtReadyForNextRead(_In_ PVOID VhfClientContext)
{
    PVHFDEVICE device = (PVHFDEVICE)VhfClientContext;

    if (device == NULL) {
        return;
    }

    WdfWaitLockAcquire(device->ReportLock, NULL);
    device->VhfReadyForReport = TRUE;

    WdfWaitLockRelease(device->ReportLock);

    VhfHidTrySubmit(device);
}

static VOID
VhfHidEvtVhfCleanup(_In_ PVOID VhfClientContext)
{
    PVHFDEVICE device = (PVHFDEVICE)VhfClientContext;

    if (device == NULL) {
        return;
    }

    WdfWaitLockAcquire(device->ReportLock, NULL);
    device->VhfHandle = NULL;
    device->VhfReadyForReport = FALSE;
    device->HasPendingReport = FALSE;
    WdfWaitLockRelease(device->ReportLock);
}

static VOID
VhfHidAcceptReport(_In_ WDFREQUEST Request, _In_ size_t InputBufferLength, _In_ PVHFHID_CONTEXT Context)
{
    PVOID    buffer = NULL;
    size_t   length = 0;
    NTSTATUS status;

    if (InputBufferLength != Context->Virtual.ReportLength) {
        WdfRequestComplete(Request, STATUS_INVALID_BUFFER_SIZE);
        return;
    }

    /*
     * Refuse the report when there is no virtual device behind this node.
     *
     * A device node can outlive its virtual device. After several install and removal cycles a node can be
     * left enumerated, still accepting IOCTLs, with the framework's child device already gone and the handle
     * cleared by the cleanup callback. Reports into it are accepted and discarded, so every call succeeds and
     * nothing happens — which is indistinguishable, from the caller's side, from a device that works.
     *
     * Returning an error here is what lets the client tell the two apart and move on to a node that does
     * have a device behind it. Without it the client has no way to choose, because success means nothing.
     */
    if (Context->Virtual.VhfHandle == NULL) {
        WdfRequestComplete(Request, STATUS_DEVICE_NOT_READY);
        return;
    }

    status = WdfRequestRetrieveInputBuffer(Request, Context->Virtual.ReportLength, &buffer, &length);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(Request, status);
        return;
    }

    WdfWaitLockAcquire(Context->Virtual.ReportLock, NULL);
    RtlCopyMemory(Context->Virtual.PendingReport, buffer, Context->Virtual.ReportLength);
    Context->Virtual.HasPendingReport = TRUE;
    WdfWaitLockRelease(Context->Virtual.ReportLock);


    VhfHidTrySubmit(&Context->Virtual);

    WdfRequestComplete(Request, STATUS_SUCCESS);
}

static VOID
VhfHidEvtIoDeviceControl(
    _In_ WDFQUEUE   Queue,
    _In_ WDFREQUEST Request,
    _In_ size_t     OutputBufferLength,
    _In_ size_t     InputBufferLength,
    _In_ ULONG      IoControlCode
    )
{
    WDFDEVICE       device = WdfIoQueueGetDevice(Queue);
    PVHFHID_CONTEXT context = VhfHidGetContext(device);

    UNREFERENCED_PARAMETER(OutputBufferLength);

    if (IoControlCode != context->IoControlCode) {
        WdfRequestComplete(Request, STATUS_INVALID_DEVICE_REQUEST);
        return;
    }

    VhfHidAcceptReport(Request, InputBufferLength, context);
}

static VOID
VhfHidEvtDeviceContextCleanup(_In_ WDFOBJECT DeviceObject)
{
    WDFDEVICE       device = (WDFDEVICE)DeviceObject;
    PVHFHID_CONTEXT context = VhfHidGetContext(device);

    if (context->Virtual.VhfHandle != NULL) {
        VhfDelete(context->Virtual.VhfHandle, TRUE);
        context->Virtual.VhfHandle = NULL;
    }
}

/*
 * Does this node create the mouse?
 *
 * The node's HardwareID decides it - root\vhfhidmouse or root\vhfhidkey - and the two nodes share one driver
 * binary, so this is the only thing that distinguishes them.
 *
 * HardwareID is a REG_MULTI_SZ, so it must be read with the multi-string query. Two earlier attempts failed,
 * both for instructive reasons:
 *
 *   - WdfRegistryQueryString on HardwareID. That call expects a REG_SZ, so it fails on a MULTI_SZ and both
 *     nodes fall back to the keyboard. The symptom - a mouse node that reports OK while creating a keyboard -
 *     is invisible until something tries to move the pointer.
 *
 *   - An IsMouse value written by the INF's AddReg. The INF contains it and the installed copy contains it,
 *     but it never reached the device's registry key, so that read failed for both nodes as well.
 *
 * HardwareID is present by construction, so it does not depend on the installer having applied a section.
 * Anything unrecognised means the keyboard, which is the safer default: it is the node that must not be
 * mistaken for a pointing device.
 */

static BOOLEAN
VhfHidIsMouseNode(_In_ WDFDEVICE Device)
{
    DEVICE_OBJECT *pdo;
    WCHAR          buffer[512];
    ULONG          length = sizeof(buffer);
    NTSTATUS       status;

    RtlZeroMemory(buffer, sizeof(buffer));

    /*
     * Read the hardware ID from the device object itself.
     *
     * Three earlier attempts failed, and each failure is worth recording because the code looked correct
     * every time:
     *
     *   - WdfRegistryQueryString on the HardwareID value: that call expects a REG_SZ and HardwareID is a
     *     REG_MULTI_SZ, so it failed and both nodes fell back to the keyboard.
     *   - An IsMouse value written by the INF's AddReg: present in the INF and in the installed copy, but
     *     never applied to the device's key, so that read failed too.
     *   - WdfRegistryQueryMultiString on HardwareID through PLUGPLAY_REGKEY_DEVICE. The multi-string call is
     *     right for the type, but the key the framework opens for that constant does not contain HardwareID:
     *     the query returns STATUS_OBJECT_NAME_NOT_FOUND. That was established by having the driver record
     *     the status in its service key, since no debugger is available here.
     *
     * IoGetDeviceProperty asks the PDO directly, so it does not depend on which registry key the framework
     * would have opened. DevicePropertyHardwareID returns a MULTI_SZ, and the first entry is the hardware ID
     * the node was created with: root\vhfhidmouse or root\vhfhidkey.
     */
    pdo = WdfDeviceWdmGetPhysicalDevice(Device);
    if (pdo == NULL) {
        return FALSE;
    }

    status = IoGetDeviceProperty(pdo, DevicePropertyHardwareID, sizeof(buffer), buffer, &length);
    if (!NT_SUCCESS(status)) {
        return FALSE;
    }

    return wcsstr(buffer, L"vhfhidmouse") != NULL;
}

static NTSTATUS
VhfHidEvtDeviceAdd(_In_ WDFDRIVER Driver, _Inout_ PWDFDEVICE_INIT DeviceInit)
{
    WDFDEVICE             device;
    PVHFHID_CONTEXT       context;
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_OBJECT_ATTRIBUTES lockAttributes;
    WDF_IO_QUEUE_CONFIG   queueConfig;
    VHF_CONFIG            config;
    const UCHAR          *descriptor;
    ULONG                 descriptorLength;   // bytes of the report DESCRIPTOR
    ULONG                 reportLength;       // bytes of one REPORT — not the same thing
    const GUID           *interfaceGuid;
    USHORT                productId;
    NTSTATUS              status;

    UNREFERENCED_PARAMETER(Driver);

    WdfDeviceInitSetDeviceType(DeviceInit, FILE_DEVICE_UNKNOWN);

    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, VHFHID_CONTEXT);
    attributes.EvtCleanupCallback = VhfHidEvtDeviceContextCleanup;

    status = WdfDeviceCreate(&DeviceInit, &attributes, &device);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    context = VhfHidGetContext(device);
    context->Device = device;
    context->IsMouse = VhfHidIsMouseNode(device);
    RtlZeroMemory(&context->Virtual, sizeof(context->Virtual));

    /*
     * The descriptor length and the report length are different numbers and must not be interchanged.
     *
     * The descriptor is the fifty-odd bytes describing the device's report format; the report is the handful
     * of bytes actually sent. Setting the report length to the descriptor length makes the driver copy fifty
     * bytes into a sixteen-byte buffer, which overflows the stack and destroys whatever followed it. That is
     * exactly what an earlier version did, and the resulting fault appeared inside a framework callback two
     * instructions later, which is why it took so long to attribute.
     */
    if (context->IsMouse) {
        descriptor = g_MouseReportDescriptor;
        descriptorLength = sizeof(g_MouseReportDescriptor);
        reportLength = VHFMOUSE_REPORT_SIZE;
        interfaceGuid = &GUID_DEVINTERFACE_VHFMOUSE;
        context->IoControlCode = IOCTL_VHFMOUSE_SEND_REPORT;
        productId = 0x5679;
    } else {
        descriptor = g_KeyboardReportDescriptor;
        descriptorLength = sizeof(g_KeyboardReportDescriptor);
        reportLength = VHFKEY_REPORT_SIZE;
        interfaceGuid = &GUID_DEVINTERFACE_VHFKEY;
        context->IoControlCode = IOCTL_VHFKEY_SEND_REPORT;
        productId = 0x5678;
    }
    context->Virtual.ReportLength = reportLength;

    WDF_OBJECT_ATTRIBUTES_INIT(&lockAttributes);
    lockAttributes.ParentObject = device;
    status = WdfWaitLockCreate(&lockAttributes, &context->Virtual.ReportLock);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
    queueConfig.EvtIoDeviceControl = VhfHidEvtIoDeviceControl;
    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    RtlZeroMemory(&config, sizeof(config));
    config.Size = sizeof(config);
    config.VhfClientContext = &context->Virtual;
    config.DeviceObject = WdfDeviceWdmGetDeviceObject(device);
    config.ReportDescriptorLength = (USHORT)descriptorLength;
    config.ReportDescriptor = (PUCHAR)descriptor;
    config.VendorID = 0x1234;
    config.ProductID = productId;
    config.VersionNumber = 1;
    config.EvtVhfReadyForNextReadReport = VhfHidEvtReadyForNextRead;
    config.EvtVhfCleanup = VhfHidEvtVhfCleanup;

    status = VhfCreate(&config, &context->Virtual.VhfHandle);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = VhfStart(context->Virtual.VhfHandle);
    if (!NT_SUCCESS(status)) {
        VhfDelete(context->Virtual.VhfHandle, TRUE);
        context->Virtual.VhfHandle = NULL;
        return status;
    }

    return WdfDeviceCreateDeviceInterface(device, interfaceGuid, NULL);
}

NTSTATUS
DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    WDF_DRIVER_CONFIG config;

    WDF_DRIVER_CONFIG_INIT(&config, VhfHidEvtDeviceAdd);
    return WdfDriverCreate(DriverObject, RegistryPath, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}
