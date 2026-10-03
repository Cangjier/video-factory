/*
 * vhfhid.h — shared definitions for the virtual HID driver and its user-mode client.
 *
 * The driver presents two HID devices to Windows through the Virtual HID Framework: a keyboard and a
 * mouse. To every consumer — the input stack, a browser, a game reading raw input — the result is
 * indistinguishable from real hardware, because as far as the system is concerned it *is* HID hardware.
 * That is the whole point: a filter driver sits beside the input path and can be bypassed or fail to
 * attach, whereas a device in the HID stack is the input path.
 *
 * The user-mode client does not call HID APIs directly. It opens the control device below and sends
 * complete HID input reports, which the driver forwards to the appropriate virtual device.
 */

#pragma once

/*
 * Device interface GUIDs.
 *
 * A user-mode client locates a device by GUID rather than by a hard-coded path, so no symbolic link name
 * has to be agreed in advance. The two devices are separate HID devices and so are identified separately.
 *
 * DEFINE_GUID only emits a definition in the translation unit that has INITGUID defined before guiddef.h is
 * reached; elsewhere it is a declaration. The driver source defines INITGUID, so the symbols live there.
 *
 * Keyboard: {6b2f9a41-3c7d-4e58-9f21-8a4c1d5e7b30}
 * Mouse:    {7c3e0b52-4d8e-4f69-a032-9b5d2e6f8c41}
 */
DEFINE_GUID(GUID_DEVINTERFACE_VHFKEY,
    0x6b2f9a41, 0x3c7d, 0x4e58, 0x9f, 0x21, 0x8a, 0x4c, 0x1d, 0x5e, 0x7b, 0x30);

DEFINE_GUID(GUID_DEVINTERFACE_VHFMOUSE,
    0x7c3e0b52, 0x4d8e, 0x4f69, 0xa0, 0x32, 0x9b, 0x5d, 0x2e, 0x6f, 0x8c, 0x41);

/*
 * One IOCTL per device, so the driver never has to guess which report a buffer holds. A single IOCTL whose
 * meaning depended on the input length would work, but the length is the only thing distinguishing the two
 * and a mistake there would be delivered to the wrong device.
 *
 * Input buffer:  the report, exactly as that device's report descriptor describes it.
 * Output buffer: none.
 */
#define VHFHID_DEVICE_TYPE 0x8000

#define IOCTL_VHFKEY_SEND_REPORT \
    CTL_CODE(VHFHID_DEVICE_TYPE, 0x800, METHOD_BUFFERED, FILE_WRITE_ACCESS)

#define IOCTL_VHFMOUSE_SEND_REPORT \
    CTL_CODE(VHFHID_DEVICE_TYPE, 0x801, METHOD_BUFFERED, FILE_WRITE_ACCESS)

/* ============================================================================================ */
/* Keyboard                                                                                      */
/* ============================================================================================ */

/*
 * The keyboard report: one byte of modifier bits, one reserved byte, then six key usages.
 *
 * This is the standard boot-protocol keyboard layout, which is what makes the device work before any
 * driver-specific knowledge is involved.
 */
#define VHFKEY_REPORT_SIZE 8
#define VHFKEY_MODIFIER_INDEX 0
#define VHFKEY_RESERVED_INDEX 1
#define VHFKEY_KEYS_INDEX     2
#define VHFKEY_KEY_SLOTS      6

#define VHFKEY_MOD_LEFT_CTRL   0x01
#define VHFKEY_MOD_LEFT_SHIFT  0x02
#define VHFKEY_MOD_LEFT_ALT    0x04
#define VHFKEY_MOD_LEFT_GUI    0x08
#define VHFKEY_MOD_RIGHT_CTRL  0x10
#define VHFKEY_MOD_RIGHT_SHIFT 0x20
#define VHFKEY_MOD_RIGHT_ALT   0x40
#define VHFKEY_MOD_RIGHT_GUI   0x80

/* ============================================================================================ */
/* Mouse                                                                                         */
/* ============================================================================================ */

/*
 * The mouse report: six bytes. The layout must match the report descriptor in vhfhid.c field for field —
 * read the two together when changing either.
 *
 *   byte 0    button bits (three buttons, five unused)
 *   bytes 1-2 X, absolute, 16-bit little-endian, 0..32767
 *   bytes 3-4 Y, absolute, 16-bit little-endian, 0..32767
 *   byte 5    vertical wheel, relative, signed
 *
 * X and Y are declared absolute over 0..32767 and are therefore *unsigned*: 0 is the left or top edge of
 * the virtual desktop and 32767 the right or bottom, exactly as a touch digitizer reports a position. A
 * caller that has measured a screen coordinate converts it into that range and the pointer lands there,
 * which is what makes "click the thing at this pixel" expressible without a movement loop.
 *
 * The wheel is relative and signed, because a wheel has no absolute position: one notch is +120 by Windows
 * convention, and the declared range (-127..127) is a single byte of two's complement. Writing an unsigned
 * value there would turn a scroll up into a scroll down.
 *
 * Buttons are momentary: the caller sends the button bits that are held down, so a click is one report with
 * the bit set followed by one without it. Every report carries the full state, so a report that omits a held
 * button releases it.
 */
#define VHFMOUSE_REPORT_SIZE 6
#define VHFMOUSE_BUTTONS_INDEX 0
#define VHFMOUSE_X_INDEX       1
#define VHFMOUSE_Y_INDEX       3
#define VHFMOUSE_WHEEL_INDEX   5

/*
 * Button bits, in the order the report descriptor declares them.
 */
#define VHFMOUSE_BUTTON_LEFT   0x01
#define VHFMOUSE_BUTTON_RIGHT  0x02
#define VHFMOUSE_BUTTON_MIDDLE 0x04

/*
 * The absolute coordinate range the descriptor declares. A caller converts a pixel position with
 *
 *   absolute = round(pixel * 32767 / (extent - 1))
 *
 * which is the same normalisation the Interception driver uses for its absolute pointer, so both
 * transports describe a position the same way.
 */
#define VHFMOUSE_ABSOLUTE_MAX 32767

/*
 * One wheel notch, by Windows convention. Positive scrolls away from the user.
 */
#define VHFMOUSE_WHEEL_DELTA 120

/*
 * A signed byte of wheel or pan movement. Kept as a named type because the sign matters: the report carries
 * two's complement, and writing an unsigned value would invert the direction.
 */
typedef signed char VHFMOUSE_DELTA, *PVHFMOUSE_DELTA;
