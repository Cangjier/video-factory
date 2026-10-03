/*
 * vhfkey.c — a virtual HID keyboard, presented through the Virtual HID Framework.
 *
 * The driver owns a HID keyboard. Because the device sits in the HID stack rather than beside it,
 * Windows routes its reports exactly as it routes a physical keyboard's, and no consumer can tell the
 * difference or decline to receive them. That property is what the earlier filter-driver approach
 * lacked: a filter can be bypassed or simply fail to attach, and on this machine its keyboard path
 * accepted keystrokes that never arrived.
 *
 * Flow, in the order the framework drives it:
 *
 *   1. VHF is told about the device once, in EvtDeviceAdd, with the report descriptor that defines it.
 *   2. The HID stack asks for a report. VHF answers by calling EvtVhfReadyForNextReadReport, which says
 *      "I can take one report now".
 *   3. User mode hands over a report with IOCTL_VHFKEY_SEND_REPORT. If VHF is waiting, the report goes
 *      straight through with VhfReadReportSubmit and becomes input. If it is not waiting, the report
 *      waits here until it is.
 *
 * The important correction over a hand-rolled design: the read queue belongs to VHF, not to this
 * driver. Implementing IOCTL_HID_READ_REPORT here would compete with the framework for requests it
 * already owns. A report is offered when the framework asks, and held when it does not.
 *
 * The report descriptor and layout are the standard eight-byte boot-protocol keyboard, so the device
 * works with the kernel's own HID and keyboard drivers and needs no companion software to be useful.
 */

// INITGUID must precede every include so that the first view of guiddef.h emits definitions rather
// than declarations. DEFINE_GUID in the header then produces the symbol the linker is looking for.
#define INITGUID

#include <ntddk.h>
#include <wdf.h>
#include <hidport.h>
#include <vhf.h>
#include <initguid.h>

#include "vhfkey.h"

/*
 * The Virtual HID Framework declarations come from vhf.h in the Windows SDK's shared include
 * directory. Hand-declaring VHF_CONFIG was tried first and would have been a trap: the real structure
 * differs in most fields from what the published prose suggests — VendorID is USHORT rather than ULONG,
 * there is no handle member, and there are members for an operation context, the device object and the
 * ready callback. VhfCreate reads the structure by offset, so a wrong layout compiles cleanly and then
 * misbehaves at run time.
 */

/*
 * The report descriptor: a standard keyboard, eight-byte reports.
 *
 * Written as a byte array because every field is fixed. It declares one modifier byte (eight one-bit
 * usages), one reserved byte, and six key slots covering the full usage range — the boot-protocol
 * layout Windows has understood since before USB existed.
 */
static const UCHAR g_ReportDescriptor[] = {
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

typedef struct _VHFKEY_CONTEXT {
    VHFHANDLE    VhfHandle;
    WDFDEVICE    Device;
    WDFWAITLOCK  ReportLock;                      // guards the slot and the flag below
    UCHAR        PendingReport[VHFKEY_REPORT_SIZE];
    BOOLEAN      HasPendingReport;
    BOOLEAN      VhfReadyForReport;               // the framework has asked for one
} VHFKEY_CONTEXT, *PVHFKEY_CONTEXT;

WDF_DECLARE_CONTEXT_TYPE_WITH_NAME(VHFKEY_CONTEXT, VhfKeyGetContext)

DRIVER_INITIALIZE DriverEntry;
EVT_WDF_DRIVER_DEVICE_ADD VhfKeyEvtDeviceAdd;
EVT_WDF_IO_QUEUE_IO_DEVICE_CONTROL VhfKeyEvtIoDeviceControl;
EVT_WDF_DEVICE_CONTEXT_CLEANUP VhfKeyEvtDeviceContextCleanup;
EVT_VHF_READY_FOR_NEXT_READ_REPORT VhfKeyEvtReadyForNextRead;

/*
 * Hand the waiting report to the framework, if there is one and the framework wants it.
 *
 * Called both when a report arrives and when the framework says it is ready, because either can come
 * first and only the pair matters. The lock is released before VhfReadReportSubmit: the call can
 * re-enter this driver, and holding a lock across it would deadlock.
 */
static VOID
VhfKeyTrySubmit(_In_ PVHFKEY_CONTEXT Context)
{
    UCHAR report[VHFKEY_REPORT_SIZE];
    BOOLEAN submit = FALSE;
    HID_XFER_PACKET packet;

    WdfWaitLockAcquire(Context->ReportLock, NULL);
    if (Context->HasPendingReport && Context->VhfReadyForReport) {
        RtlCopyMemory(report, Context->PendingReport, VHFKEY_REPORT_SIZE);
        Context->HasPendingReport = FALSE;
        Context->VhfReadyForReport = FALSE;
        submit = TRUE;
    }
    WdfWaitLockRelease(Context->ReportLock);

    if (!submit) {
        return;
    }

    packet.reportBuffer = report;
    packet.reportBufferLen = VHFKEY_REPORT_SIZE;
    packet.reportId = 0;
    (VOID)VhfReadReportSubmit(Context->VhfHandle, &packet);
}

/*
 * The framework is ready for one report.
 *
 * This is a notification, not a request: VHF owns the read queue and will accept exactly one report
 * per call. The flag is set here and cleared when a report actually goes out, so a report that arrives
 * while the framework is busy is not dropped.
 */
static VOID
VhfKeyEvtReadyForNextRead(_In_ PVOID VhfClientContext)
{
    PVHFKEY_CONTEXT context = (PVHFKEY_CONTEXT)VhfClientContext;

    WdfWaitLockAcquire(context->ReportLock, NULL);
    context->VhfReadyForReport = TRUE;
    WdfWaitLockRelease(context->ReportLock);

    VhfKeyTrySubmit(context);
}

/*
 * IOCTL_VHFKEY_SEND_REPORT: user mode supplying one keyboard report.
 *
 * The length is checked against what the descriptor declares. A short buffer would be read past its
 * end, and a long one would be truncated into a report the HID stack never agreed to.
 */
static VOID
VhfKeyEvtIoDeviceControl(
    _In_ WDFQUEUE   Queue,
    _In_ WDFREQUEST Request,
    _In_ size_t     OutputBufferLength,
    _In_ size_t     InputBufferLength,
    _In_ ULONG      IoControlCode
    )
{
    WDFDEVICE       device = WdfIoQueueGetDevice(Queue);
    PVHFKEY_CONTEXT context = VhfKeyGetContext(device);
    PVOID           buffer = NULL;
    size_t          length = 0;
    NTSTATUS        status;

    UNREFERENCED_PARAMETER(OutputBufferLength);

    if (IoControlCode != IOCTL_VHFKEY_SEND_REPORT) {
        WdfRequestComplete(Request, STATUS_INVALID_DEVICE_REQUEST);
        return;
    }
    if (InputBufferLength != VHFKEY_REPORT_SIZE) {
        WdfRequestComplete(Request, STATUS_INVALID_BUFFER_SIZE);
        return;
    }

    status = WdfRequestRetrieveInputBuffer(Request, VHFKEY_REPORT_SIZE, &buffer, &length);
    if (!NT_SUCCESS(status)) {
        WdfRequestComplete(Request, status);
        return;
    }

    WdfWaitLockAcquire(context->ReportLock, NULL);
    // A newer report replaces an older one rather than queueing behind it. For a keyboard that is the
    // right behaviour: holding two reports would replay a keystroke the user has already finished.
    RtlCopyMemory(context->PendingReport, buffer, VHFKEY_REPORT_SIZE);
    context->HasPendingReport = TRUE;
    WdfWaitLockRelease(context->ReportLock);

    VhfKeyTrySubmit(context);
    WdfRequestComplete(Request, STATUS_SUCCESS);
}

static VOID
VhfKeyEvtDeviceContextCleanup(_In_ WDFOBJECT DeviceObject)
{
    WDFDEVICE       device = (WDFDEVICE)DeviceObject;
    PVHFKEY_CONTEXT context = VhfKeyGetContext(device);
    if (context->VhfHandle != NULL) {
        // Wait, so the framework has released the handle before the context disappears.
        VhfDelete(context->VhfHandle, TRUE);
        context->VhfHandle = NULL;
    }
}

static NTSTATUS
VhfKeyEvtDeviceAdd(_In_ WDFDRIVER Driver, _Inout_ PWDFDEVICE_INIT DeviceInit)
{
    WDFDEVICE             device;
    PVHFKEY_CONTEXT       context;
    WDF_OBJECT_ATTRIBUTES attributes;
    WDF_IO_QUEUE_CONFIG   queueConfig;
    VHF_CONFIG            vhfConfig;
    NTSTATUS              status;

    UNREFERENCED_PARAMETER(Driver);

    WdfDeviceInitSetDeviceType(DeviceInit, FILE_DEVICE_UNKNOWN);

    WDF_OBJECT_ATTRIBUTES_INIT_CONTEXT_TYPE(&attributes, VHFKEY_CONTEXT);
    // The member is EvtCleanupCallback. WDF runs it as the device is torn down, which is where the VHF
    // handle must be given back.
    attributes.EvtCleanupCallback = VhfKeyEvtDeviceContextCleanup;

    status = WdfDeviceCreate(&DeviceInit, &attributes, &device);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    context = VhfKeyGetContext(device);
    context->Device = device;
    context->HasPendingReport = FALSE;
    context->VhfReadyForReport = FALSE;
    context->VhfHandle = NULL;

    WDF_OBJECT_ATTRIBUTES_INIT(&attributes);
    attributes.ParentObject = device;
    status = WdfWaitLockCreate(&attributes, &context->ReportLock);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    // One queue for user-mode reports. Sequential, so two reports cannot interleave into a keystroke
    // that neither caller asked for.
    WDF_IO_QUEUE_CONFIG_INIT_DEFAULT_QUEUE(&queueConfig, WdfIoQueueDispatchSequential);
    queueConfig.EvtIoDeviceControl = VhfKeyEvtIoDeviceControl;
    status = WdfIoQueueCreate(device, &queueConfig, WDF_NO_OBJECT_ATTRIBUTES, WDF_NO_HANDLE);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    /*
     * Create the virtual device, using the layout vhf.h declares.
     *
     * ReportDescriptorLength is a byte count, not an element count. Passing the element count would
     * under-report the descriptor and the HID stack would parse a truncated one.
     */
    RtlZeroMemory(&vhfConfig, sizeof(vhfConfig));
    vhfConfig.Size = sizeof(vhfConfig);
    vhfConfig.VhfClientContext = context;
    vhfConfig.OperationContextSize = 0;
    vhfConfig.DeviceObject = WdfDeviceWdmGetDeviceObject(device);
    vhfConfig.ReportDescriptorLength = (USHORT)sizeof(g_ReportDescriptor);
    vhfConfig.ReportDescriptor = (PUCHAR)g_ReportDescriptor;
    vhfConfig.VendorID = 0x1234;      // deliberately generic; nothing depends on the value
    vhfConfig.ProductID = 0x5678;
    vhfConfig.VersionNumber = 1;
    vhfConfig.EvtVhfReadyForNextReadReport = VhfKeyEvtReadyForNextRead;

    status = VhfCreate(&vhfConfig, &context->VhfHandle);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    status = VhfStart(context->VhfHandle);
    if (!NT_SUCCESS(status)) {
        VhfDelete(context->VhfHandle, TRUE);
        context->VhfHandle = NULL;
        return status;
    }

    // An interface, so user mode can find the device by GUID rather than by a path whose shape depends
    // on enumeration order.
    status = WdfDeviceCreateDeviceInterface(device, &GUID_DEVINTERFACE_VHFKEY, NULL);
    if (!NT_SUCCESS(status)) {
        return status;
    }

    return STATUS_SUCCESS;
}

NTSTATUS
DriverEntry(_In_ PDRIVER_OBJECT DriverObject, _In_ PUNICODE_STRING RegistryPath)
{
    WDF_DRIVER_CONFIG config;

    WDF_DRIVER_CONFIG_INIT(&config, VhfKeyEvtDeviceAdd);
    return WdfDriverCreate(DriverObject, RegistryPath, WDF_NO_OBJECT_ATTRIBUTES, &config, WDF_NO_HANDLE);
}
