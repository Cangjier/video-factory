/*
 * vhfkey.h — shared definitions for the virtual HID keyboard driver and its user-mode client.
 *
 * The driver presents a HID keyboard to Windows through the Virtual HID Framework. To every consumer
 * — the input stack, a browser, a game reading raw input — the result is indistinguishable from a
 * physical keyboard, because it *is* a HID device as far as the system is concerned. That is the whole
 * point: a filter driver sits beside the input path and can be bypassed or ignored, whereas a device
 * in the HID stack is the input path.
 *
 * The user-mode client does not call HID APIs directly. It opens the control device below and sends
 * complete HID input reports, which the driver forwards to the virtual device.
 *
 * Why not Interception: it is a filter driver, so it does not own a device and its attachment cannot be
 * relied on — measured on this machine, its mouse path works and its keyboard path accepts keystrokes
 * that never arrive. Owning the device removes that dependency.
 */

#pragma once

/*
 * The device interface GUID.
 *
 * DEFINE_GUID only emits a definition in the translation unit that has INITGUID defined before
 * guiddef.h is reached; elsewhere it is a declaration. The driver source defines INITGUID, so the
 * symbol lives there — without that, the link fails with "unresolved external symbol
 * GUID_DEVINTERFACE_VHFKEY" even though the GUID looks defined in every file that includes this header.
 *
 * {6b2f9a41-3c7d-4e58-9f21-8a4c1d5e7b30}
 */
DEFINE_GUID(GUID_DEVINTERFACE_VHFKEY,
    0x6b2f9a41, 0x3c7d, 0x4e58, 0x9f, 0x21, 0x8a, 0x4c, 0x1d, 0x5e, 0x7b, 0x30);

/*
 * IOCTL_VHFKEY_SEND_REPORT — deliver one HID input report.
 *
 * Input buffer:  the report, exactly as the HID report descriptor describes it.
 * Output buffer: none.
 *
 * The size is checked against the report length the descriptor declares, so a short or long buffer is
 * rejected rather than truncated into a malformed report.
 */
#define VHFKEY_DEVICE_TYPE 0x8000
#define IOCTL_VHFKEY_SEND_REPORT \
    CTL_CODE(VHFKEY_DEVICE_TYPE, 0x800, METHOD_BUFFERED, FILE_WRITE_ACCESS)

/*
 * The keyboard report: one byte of modifier bits, one reserved byte, then six key usages.
 *
 * This is the standard boot-protocol keyboard layout, which is what makes the device work before any
 * driver-specific knowledge is involved. The reserved byte is part of the layout and must be sent as
 * zero.
 */
#define VHFKEY_REPORT_SIZE 8

/*
 * Indices into the report, named so the client does not have to remember the layout.
 */
#define VHFKEY_MODIFIER_INDEX 0
#define VHFKEY_RESERVED_INDEX 1
#define VHFKEY_KEYS_INDEX     2
#define VHFKEY_KEY_SLOTS      6

/*
 * Modifier bits, in the order the report descriptor declares them.
 */
#define VHFKEY_MOD_LEFT_CTRL   0x01
#define VHFKEY_MOD_LEFT_SHIFT  0x02
#define VHFKEY_MOD_LEFT_ALT    0x04
#define VHFKEY_MOD_LEFT_GUI    0x08
#define VHFKEY_MOD_RIGHT_CTRL  0x10
#define VHFKEY_MOD_RIGHT_SHIFT 0x20
#define VHFKEY_MOD_RIGHT_ALT   0x40
#define VHFKEY_MOD_RIGHT_GUI   0x80
