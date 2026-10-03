/*
 * vhfhid.c — virtual HID keyboard and mouse, presented through the Virtual HID Framework.
 *
 * The driver owns two HID devices. Because they sit in the HID stack rather than beside it, Windows routes
 * their reports exactly as it routes real hardware's, and no consumer can tell the difference or decline to
 * receive them. That property is what the earlier filter-driver approach lacked: a filter can be bypassed
 * or simply fail to attach, and on this machine its keyboard path accepted keystrokes that never arrived.
 *
 * Flow, in the order the framework drives it, once per device:
 *
 *   1. VHF is told about the device, with the report descriptor that defines it.
 *   2. The HID stack asks for a report. VHF answers by calling the ready callback, which says "I can take
 *      one report now".
 *   3. User mode hands over a report through that device's IOCTL. If VHF is waiting, the report goes
 *      through with VhfReadReportSubmit and becomes input; if not, it waits here until it is.
 *
 * The read queue belongs to VHF, not to this driver. Implementing IOCTL_HID_READ_REPORT here would compete
 * with the framework for requests it already owns.
 *
 * Both devices share one implementation. The per-device state lives in VHFDEVICE, and VHF_CONFIG's
 * VhfClientContext points at the right one, so the ready and cleanup callbacks know which device they are
 * being told about without a lookup or a global.
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
 * would have been a trap: the real structure differs in most fields from what the published prose suggests
 * — VendorID is USHORT rather than ULONG, there is no handle member, and there are members for an
 * operation context, the device object and the ready callback. VhfCreate reads it by offset, so a wrong
 * layout compiles cleanly and then misbehaves at run time.
 */

/*
 * The keyboard report descriptor: a standard keyboard, eight-byte reports.
 *
 * It declares one modifier byte (eight one-bit usages), one reserved byte, and six key slots covering the
 * full usage range — the boot-protocol layout Windows has understood since before USB existed.
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
 * The report is six bytes and the fields follow in this order — the client builds its reports to match, so
 * the two must be read together:
 *
 *   byte 0       three button bits, then five bits of padding to reach the byte boundary
 *   bytes 1-2    X, absolute, 16-bit little-endian, 0..32767
 *   bytes 3-4    Y, absolute, 16-bit little-endian, 0..32767
 *   byte 5       vertical wheel, relative, signed
 *
 * The padding is not decoration. Without it the axes would begin mid-byte and every following field would
 * be offset by five bits, which the HID parser would reject as a report that does not match its descriptor.
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
 * Per-device state.
 *
 * Two of these exist, one per virtual device, and each VHF_CONFIG carries a pointer to its own so the
 * callbacks are told which device they concern rather than having to work it out.
 */
typedef struct _VHFDEVICE {
    VHFHANDLE    VhfHandle;
    WDFWAITLOCK  ReportLock;                      // guards the slot and the flag below
    UCHAR        PendingReport[16];               // large enough for either device's report
    ULONG        ReportLength;                    // the length that device's descriptor declares
    BOOLEAN      HasPendingReport;
    BOOLEAN      VhfReadyForReport;               // the framework has asked for one
} VHFDEVICE, *PVHFDEVICE;

typedef struct _VHFHID_CONTEXT {
    WDFDEVICE    Device;
    VHFDEVICE    Keyboard;
    VHFDEVICE    Mouse;
} VHFHID_CONTEXT, *PVHFHID_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(VHFHID_CONTEXT, VhfHidGetContext)

DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD VhfHidEvtDeviceAdd;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL VhfHidEvtIoDeviceControl;
EVT_WDF_DEVICE_CONTEXT_CLEANUP VhfHidEvtDeviceContextCleanup;
EVT_VHF_READY_FOR_NEXT_READ_REPORT VhfHidEvtReadyForNextRead;
EVT_VHF_CLEANUP VhfHidEvtVhfCleanup;

/*
 * Hand the waiting report to the framework, if there is one and the framework wants it.
 *
 * Called both when a report arrives and when the framework says it is ready, because either can come first
 * and only the pair matters. The lock is released before VhfReadReportSubmit: the call can re-enter this
 * driver, and holding a lock across it would deadlock.
 */
static VOID
VhfHidTrySubmit(_In_ PVHFDEVICE Device)
{
    UCHAR report[16];
    ULONG length;
    BOOLEAN submit = FALSE;
    VHFHANDLE handle = NULL;
    HID_XFER_PACKET packet;

    WdfWaitLockAcquire(Device->ReportLock, NULL);
    // The handle is tested under the lock because the cleanup callback clears it: between a report arriving
    // and this call the device can be removed, and submitting to a null handle is an access violation inside
    // a kernel path — the same class of failure the /DLL bug produced.
    if (Device->HasPendingReport && Device->VhfReadyForReport && Device->VhfHandle != NULL) {
        length = Device->ReportLength;
        RtlCopyMemory(report, Device->PendingReport, length);
        Device->HasPendingReport = FALSE;
        Device->VhfReadyForReport = FALSE;
        handle = Device->VhfHandle;
        submit = TRUE;
    }
    WdfWaitLockRelease(Device->ReportLock);

    if (!submit) {
        return;
    }

    packet.reportBuffer = report;
    packet.reportBufferLen = length;
    packet.reportId = 0;
    (VOID)VhfReadReportSubmit(handle, &packet);
}

/*
 * The framework is ready for one report.
 *
 * A notification, not a request: VHF owns the read queue and will accept exactly one report per call. The
 * flag is set here and cleared when a report actually goes out, so a report that arrives while the framework
 * is busy is not dropped.
 */
static VOID
VhfHidEvtReadyForNextRead(_In_ PVOID VhfClientContext)
{
    PVHFDEVICE device = (PVHFDEVICE)VhfClientContext;

    WdfWaitLockAcquire(device->ReportLock, NULL);
    device->VhfReadyForReport = TRUE;
    WdfWaitLockRelease(device->ReportLock);

    VhfHidTrySubmit(device);
}

/*
 * VHF has finished with the handle and will not call back again.
 *
 * Required because this driver holds resources for the virtual device. Without it there is nothing to tell
 * the driver that the framework has stopped referencing the client context, so a callback already in flight
 * could arrive after the context has been freed.
 */
static VOID
VhfHidEvtVhfCleanup(_In_ PVOID VhfClientContext)
{
    PVHFDEVICE device = (PVHFDEVICE)VhfClientContext;

    device->VhfHandle = NULL;
    device->VhfReadyForReport = FALSE;
    device->HasPendingReport = FALSE;
}

/*
 * A report arrived from user mode.
 *
 * The device is chosen by the IOCTL, not by the buffer length, so a report can never be delivered to the
 * wrong virtual device. The length is then checked against what that device's descriptor declares: a short
 * buffer would be read past its end, and a long one truncated into a report the HID stack never agreed to.
 */
static VOID
VhfHidAcceptReport(
    _In_ WDFREQUEST Request,
    _In_ size_t InputBufferLength,
    _In_ PVHFDEVICE Device,
    _In_ ULONG ExpectedLength,
    _In_ PCSTR DeviceName
    )
{
    PVOID buffer = NULL;
    size_t length = 0;
    NTSTATUS status;

    /*
     * The length is checked against what the descriptor declares before the buffer is touched: a short
     * buffer would be read past its end, and a long one truncated into a report the HID stack never agreed
     * to. Both are refused rather than guessed at.
     *
     * The reported expectation names the device, because "invalid buffer size" on its own does not say
     * whether the keyboard or the mouse was being spoken to.
     */
    if (InputBufferLength != ExpectedLength) {
        DbgPrintEx(DPFLTR_IHVDRIVER_ID, DPFLTR_ERROR_LEVEL,
                   "vhfhid: %s report length %Iu, expected %lu\n", DeviceName, InputBufferLength, ExpectedLength);
        WdfRequestComplete(Request, STATUS_INVALID_BUFFER_SIZE);
        return;
    }

    status = WdfRequestRetrieveInputBuffer(Request, ExpectedLength, &buffer, &length);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(Request, status);
        return;
    }

    WdfWaitLockAcquire(Device->ReportLock, NULL);
    // A newer report replaces an older one rather than queueing behind it. For an input device that is the
    // right behaviour: holding two reports would replay a movement or a keystroke the user has finished.
    RtlCopyMemory(Device->PendingReport, buffer, ExpectedLength);
    Device->HasPendingReport = TRUE;
    WdfWaitLockRelease(Device->ReportLock);

    VhfHidTrySubmit(Device);
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

    switch (IoControlCode) {
    case IOCTL_VHFKEY_SEND_REPORT:
        VhfHidAcceptReport(Request, InputBufferLength, &context->Keyboard, VHFKEY_REPORT_SIZE, "keyboard");
        return;
    case IOCTL_VHFMOUSE_SEND_REPORT:
        VhfHidAcceptReport(Request, InputBufferLength, &context->Mouse, VHFMOUSE_REPORT_SIZE, "mouse");
        return;
    default:
        WdfRequestComplete(Request, STATUS_INVALID_DEVICE_REQUEST);
        return;
    }
}

static VOID
VhfHidEvtDeviceContextCleanup(_In_ WDFOBJECT DeviceObject)
{
    WDFDEVICE       device = (WDFDEVICE)DeviceObject;
    PVHFHID_CONTEXT context = VhfHidGetContext(device);

    // Wait, so the framework has released each handle before the context disappears.
    if (context->Keyboard.VhfHandle != NULL) {
        VhfDelete(context->Keyboard.VhfHandle, TRUE);
        context->Keyboard.VhfHandle = NULL;
    }
    if (context->Mouse.VhfHandle != NULL) {
        VhfDelete(context->Mouse.VhfHandle, TRUE);
        context->Mouse.VhfHandle = NULL;
    }
}

/*
 * Create one virtual device.
 *
 * Shared by both, because the only differences are the descriptor, its length, the interface GUID and which
 * VHFDEVICE holds the state. Writing it twice would have meant two places for the same mistake.
 */
static NTSTATUS
VhfHidCreateDevice(
    _In_ WDFDEVICE Device,
    _In_ PVHFDEVICE State,
    _In_reads_(DescriptorLength) const UCHAR *Descriptor,
    _In_ ULONG DescriptorLength,
    _In_ const GUID *InterfaceGuid,
    _In_ USHORT VendorId,
    _In_ USHORT ProductId
    )
{
    VHF_CONFIG            config;
    WDF_OBJECT_ATTRIBUTES lockAttributes;
    NTSTATUS             status;

    State->ReportLength = DescriptorLength;

    /*
     * The lock is parented to the device, not to the driver.
     *
     * WDF_NO_OBJECT_ATTRIBUTES would parent it to the driver object, which outlives the device. The lock
     * would then be disposed of at driver unload rather than at device removal, so during a device restart
     * the framework could still be calling into this driver while the lock it depends on had been torn down
     * with the rest of the device's objects — reading freed memory, which is what the crash in
     * VhfHidTrySubmit was: a device pointer that was no longer valid.
     */
    WDF_OBJECT_ATTRIBUTES_INIT(&lockAttributes);
    lockAttributes.ParentObject = Device;
    status = WdfWaitLockCreate(&lockAttributes, &State->ReportLock);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    /*
     * Create the virtual device, using the layout vhf.h declares.
     *
     * ReportDescriptorLength is a byte count, not an element count. Passing the element count would
     * under-report the descriptor and the HID stack would parse a truncated one.
     */
    RtlZeroMemory(&config, sizeof(config));
    config.Size = sizeof(config);
    config.VhfClientContext = State;
    config.DeviceObject = WdfDeviceWdmGetDeviceObject(Device);
    config.ReportDescriptorLength = (USHORT)DescriptorLength;
    config.ReportDescriptor = (PUCHAR)Descriptor;
    config.VendorID = VendorId;
    config.ProductID = ProductId;
    config.VersionNumber = 1;
    config.EvtVhfReadyForNextReadReport = VhfHidEvtReadyForNextRead;
    config.EvtVhfCleanup = VhfHidEvtVhfCleanup;

    status = VhfCreate(&config, &State->VhfHandle);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = VhfStart(State->VhfHandle);
    if (!NT_SUCCESS(status)) {
        VhfDelete(State->VhfHandle, TRUE);
        State->VhfHandle = NULL;
        return status;
    }

    // An interface so user mode can find this device by GUID rather than by a path whose shape depends on
    // enumeration order — and so it can tell the two devices apart.
    return WdfDeviceCreateDeviceInterface(Device, InterfaceGuid, NULL);
}

static NTSTATUS
VhfHidEvtDeviceAdd(_In_ WDFDRIVER Driver, _Inout_ PWDFDEVICE_INIT DeviceInit)
{
    WDFDEVICE         device;
    PVHFHID_CONTEXT   context;
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_IO_QUEUE_CONFIG   queueConfig;
    NTSTATUS          status;

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
    RtlZeroMemory(&context->Keyboard, sizeof(context->Keyboard));
    RtlZeroMemory(&context->Mouse, sizeof(context->Mouse));

    // One queue for user-mode reports. Sequential, so two reports cannot interleave into an input event that
    // neither caller asked for.
    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
    queueConfig.EvtIoDeviceControl = VhfHidEvtIoDeviceControl;
    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = VhfHidCreateDevice(device, &context->Keyboard, g_KeyboardReportDescriptor,
                                sizeof(g_KeyboardReportDescriptor), &GUID_DEVINTERFACE_VHFKEY, 0x1234, 0x5678);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = VhfHidCreateDevice(device, &context->Mouse, g_MouseReportDescriptor,
                                sizeof(g_MouseReportDescriptor), &GUID_DEVINTERFACE_VHFMOUSE, 0x1234, 0x5679);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    return STATUS_SUCCESS;
}

NTSTATUS
DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    WDF_DRIVER_CONFIG config;

    WDF_DRIVER_CONFIG_INIT(&config, VhfHidEvtDeviceAdd);
    return WdfDriverCreate(DriverObject, RegistryPath, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}
