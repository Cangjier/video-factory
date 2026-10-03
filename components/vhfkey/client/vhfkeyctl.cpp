/*
 * vhfkeyctl.cpp — user-mode client for the virtual HID keyboard.
 *
 * Opens the driver's device interface and sends HID input reports. It carries no HID knowledge of its
 * own beyond the eight-byte boot-protocol layout, which the driver's descriptor also declares, so the
 * two cannot disagree about the format without one of them failing loudly.
 *
 * Usage:
 *   vhfkeyctl type <text>        type literal ASCII text
 *   vhfkeyctl key <name>         press one key by name (ENTER, TAB, A, F5, ...)
 *   vhfkeyctl combo <mod> <name> hold a modifier while pressing a key (CTRL, SHIFT, ALT, WIN)
 *   vhfkeyctl probe              report whether the device is present
 *
 * Exit codes: 0 success, 2 device not found, 3 bad usage, 4 unrecognised key.
 *
 * Every keystroke is sent as a press report followed by a release report, with a short gap. A keyboard
 * that never releases a key leaves the system convinced the key is held down, which turns one typo into
 * a stuck modifier for the rest of the session.
 */

#include <windows.h>
#include <setupapi.h>
#include <initguid.h>
#include <stdio.h>
#include <string.h>

#include "vhfkey.h"

#pragma comment(lib, "setupapi.lib")

/*
 * PS/2 Set 1 scan codes, which are also the HID keyboard usages for the common keys. The two tables
 * agree for everything listed here, so one table serves both.
 */
struct KeyEntry {
    const char *name;
    unsigned char code;
    unsigned char shifted;   // the code to press while Shift is held, or 0 when Shift is not needed
};

static const KeyEntry g_Keys[] = {
    { "A", 0x04, 0 }, { "B", 0x05, 0 }, { "C", 0x06, 0 }, { "D", 0x07, 0 }, { "E", 0x08, 0 },
    { "F", 0x09, 0 }, { "G", 0x0A, 0 }, { "H", 0x0B, 0 }, { "I", 0x0C, 0 }, { "J", 0x0D, 0 },
    { "K", 0x0E, 0 }, { "L", 0x0F, 0 }, { "M", 0x10, 0 }, { "N", 0x11, 0 }, { "O", 0x12, 0 },
    { "P", 0x13, 0 }, { "Q", 0x14, 0 }, { "R", 0x15, 0 }, { "S", 0x16, 0 }, { "T", 0x17, 0 },
    { "U", 0x18, 0 }, { "V", 0x19, 0 }, { "W", 0x1A, 0 }, { "X", 0x1B, 0 }, { "Y", 0x1C, 0 },
    { "Z", 0x1D, 0 },
    { "1", 0x1E, 0 }, { "2", 0x1F, 0 }, { "3", 0x20, 0 }, { "4", 0x21, 0 }, { "5", 0x22, 0 },
    { "6", 0x23, 0 }, { "7", 0x24, 0 }, { "8", 0x25, 0 }, { "9", 0x26, 0 }, { "0", 0x27, 0 },
    { "ENTER", 0x28, 0 }, { "ESC", 0x29, 0 }, { "BACKSPACE", 0x2A, 0 }, { "TAB", 0x2B, 0 },
    { "SPACE", 0x2C, 0 }, { "MINUS", 0x2D, 0 }, { "EQUAL", 0x2E, 0 },
    { "LBRACKET", 0x2F, 0 }, { "RBRACKET", 0x30, 0 }, { "BACKSLASH", 0x31, 0 },
    { "SEMICOLON", 0x33, 0 }, { "QUOTE", 0x34, 0 }, { "GRAVE", 0x35, 0 },
    { "COMMA", 0x36, 0 }, { "PERIOD", 0x37, 0 }, { "SLASH", 0x38, 0 },
    { "CAPSLOCK", 0x39, 0 },
    { "F1", 0x3A, 0 }, { "F2", 0x3B, 0 }, { "F3", 0x3C, 0 }, { "F4", 0x3D, 0 }, { "F5", 0x3E, 0 },
    { "F6", 0x3F, 0 }, { "F7", 0x40, 0 }, { "F8", 0x41, 0 }, { "F9", 0x42, 0 }, { "F10", 0x43, 0 },
    { "F11", 0x44, 0 }, { "F12", 0x45, 0 },
    { "DELETE", 0x4C, 0 }, { "INSERT", 0x49, 0 }, { "HOME", 0x4A, 0 }, { "END", 0x4D, 0 },
    { "PAGEUP", 0x4B, 0 }, { "PAGEDOWN", 0x4E, 0 },
    { "RIGHT", 0x4F, 0 }, { "LEFT", 0x50, 0 }, { "DOWN", 0x51, 0 }, { "UP", 0x52, 0 },
};

/* Characters that need Shift, mapped to the key they sit on. */
struct CharEntry {
    char ch;
    const char *key;
    bool shift;
};

static const CharEntry g_Chars[] = {
    { 'a', "A", false }, { 'b', "B", false }, { 'c', "C", false }, { 'd', "D", false },
    { 'e', "E", false }, { 'f', "F", false }, { 'g', "G", false }, { 'h', "H", false },
    { 'i', "I", false }, { 'j', "J", false }, { 'k', "K", false }, { 'l', "L", false },
    { 'm', "M", false }, { 'n', "N", false }, { 'o', "O", false }, { 'p', "P", false },
    { 'q', "Q", false }, { 'r', "R", false }, { 's', "S", false }, { 't', "T", false },
    { 'u', "U", false }, { 'v', "V", false }, { 'w', "W", false }, { 'x', "X", false },
    { 'y', "Y", false }, { 'z', "Z", false },
    { 'A', "A", true },  { 'B', "B", true },  { 'C', "C", true },  { 'D', "D", true },
    { 'E', "E", true },  { 'F', "F", true },  { 'G', "G", true },  { 'H', "H", true },
    { 'I', "I", true },  { 'J', "J", true },  { 'K', "K", true },  { 'L', "L", true },
    { 'M', "M", true },  { 'N', "N", true },  { 'O', "O", true },  { 'P', "P", true },
    { 'Q', "Q", true },  { 'R', "R", true },  { 'S', "S", true },  { 'T', "T", true },
    { 'U', "U", true },  { 'V', "V", true },  { 'W', "W", true },  { 'X', "X", true },
    { 'Y', "Y", true },  { 'Z', "Z", true },
    { '1', "1", false }, { '2', "2", false }, { '3', "3", false }, { '4', "4", false },
    { '5', "5", false }, { '6', "6", false }, { '7', "7", false }, { '8', "8", false },
    { '9', "9", false }, { '0', "0", false },
    { ' ', "SPACE", false }, { '\n', "ENTER", false }, { '\t', "TAB", false },
    { '-', "MINUS", false }, { '=', "EQUAL", false }, { '[', "LBRACKET", false },
    { ']', "RBRACKET", false }, { '\\', "BACKSLASH", false }, { ';', "SEMICOLON", false },
    { '\'', "QUOTE", false }, { '`', "GRAVE", false }, { ',', "COMMA", false },
    { '.', "PERIOD", false }, { '/', "SLASH", false },
    { '!', "1", true }, { '@', "2", true }, { '#', "3", true }, { '$', "4", true },
    { '%', "5", true }, { '^', "6", true }, { '&', "7", true }, { '*', "8", true },
    { '(', "9", true }, { ')', "0", true }, { '_', "MINUS", true }, { '+', "EQUAL", true },
    { '{', "LBRACKET", true }, { '}', "RBRACKET", true }, { '|', "BACKSLASH", true },
    { ':', "SEMICOLON", true }, { '"', "QUOTE", true }, { '~', "GRAVE", true },
    { '<', "COMMA", true }, { '>', "PERIOD", true }, { '?', "SLASH", true },
};

/*
 * A leading K_ avoids the names winuser.h already owns as macros.
 *
 * K_ALT, K_SHIFT and MOD_CONTROL are defined in the Windows headers as plain integers, so a
 * declaration with one of those names is rewritten by the preprocessor before the compiler sees it and
 * fails as a syntax error on a constant — a message that says nothing about the macro that caused it.
 */
static const unsigned char K_CTRL  = VHFKEY_MOD_LEFT_CTRL;
static const unsigned char K_SHIFT = VHFKEY_MOD_LEFT_SHIFT;
static const unsigned char K_ALT   = VHFKEY_MOD_LEFT_ALT;
static const unsigned char K_WIN   = VHFKEY_MOD_LEFT_GUI;

static const KeyEntry *FindKey(const char *name)
{
    for (size_t i = 0; i < sizeof(g_Keys) / sizeof(g_Keys[0]); ++i) {
        if (_stricmp(g_Keys[i].name, name) == 0) {
            return &g_Keys[i];
        }
    }
    return NULL;
}

/*
 * Find the device by interface GUID.
 *
 * The path is not stable across enumerations, so it is looked up every run rather than cached
 * anywhere.
 */
static HANDLE OpenDevice(void)
{
    HDEVINFO info = SetupDiGetClassDevs(&GUID_DEVINTERFACE_VHFKEY, NULL, NULL, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (info == INVALID_HANDLE_VALUE) {
        return INVALID_HANDLE_VALUE;
    }

    SP_DEVICE_INTERFACE_DATA interfaceData;
    interfaceData.cbSize = sizeof(interfaceData);
    HANDLE device = INVALID_HANDLE_VALUE;

    for (DWORD index = 0; SetupDiEnumDeviceInterfaces(info, NULL, &GUID_DEVINTERFACE_VHFKEY, index, &interfaceData); ++index) {
        DWORD needed = 0;
        SetupDiGetDeviceInterfaceDetail(info, &interfaceData, NULL, 0, &needed, NULL);
        if (needed == 0) {
            continue;
        }
        SP_DEVICE_INTERFACE_DETAIL_DATA *detail = (SP_DEVICE_INTERFACE_DETAIL_DATA *)malloc(needed);
        if (detail == NULL) {
            break;
        }
        detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA);
        if (SetupDiGetDeviceInterfaceDetail(info, &interfaceData, detail, needed, NULL, NULL)) {
            device = CreateFile(detail->DevicePath,
                                GENERIC_WRITE | GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE,
                                NULL, OPEN_EXISTING, 0, NULL);
        }
        free(detail);
        if (device != INVALID_HANDLE_VALUE) {
            break;
        }
    }

    SetupDiDestroyDeviceInfoList(info);
    return device;
}

/* Send one eight-byte report. */
static bool SendReport(HANDLE device, unsigned char modifier, unsigned char key)
{
    unsigned char report[VHFKEY_REPORT_SIZE];
    memset(report, 0, sizeof(report));
    report[VHFKEY_MODIFIER_INDEX] = modifier;
    if (key != 0) {
        report[VHFKEY_KEYS_INDEX] = key;
    }

    DWORD written = 0;
    BOOL ok = DeviceIoControl(device, IOCTL_VHFKEY_SEND_REPORT,
                              report, sizeof(report),
                              NULL, 0, &written, NULL);
    return ok != FALSE;
}

/*
 * Press and release one key.
 *
 * The release is always sent, including when the press failed, because a failure after the key has
 * been registered would otherwise leave it held down system-wide.
 */
static bool TapKey(HANDLE device, unsigned char key, unsigned char modifier)
{
    bool pressed = SendReport(device, modifier, key);
    Sleep(12);
    bool released = SendReport(device, 0, 0);
    Sleep(12);
    return pressed && released;
}

static bool TypeText(HANDLE device, const char *text)
{
    for (const char *p = text; *p != '\0'; ++p) {
        const CharEntry *entry = NULL;
        for (size_t i = 0; i < sizeof(g_Chars) / sizeof(g_Chars[0]); ++i) {
            if (g_Chars[i].ch == *p) {
                entry = &g_Chars[i];
                break;
            }
        }
        if (entry == NULL) {
            fprintf(stderr, "no mapping for character 0x%02X\n", (unsigned char)*p);
            return false;
        }
        const KeyEntry *key = FindKey(entry->key);
        if (key == NULL) {
            fprintf(stderr, "internal error: unknown key name '%s'\n", entry->key);
            return false;
        }
        unsigned char modifier = entry->shift ? K_SHIFT : 0;
        if (!TapKey(device, key->code, modifier)) {
            return false;
        }
    }
    return true;
}

static void Usage(void)
{
    fprintf(stderr,
            "usage:\n"
            "  vhfkeyctl type <text>\n"
            "  vhfkeyctl key <NAME>\n"
            "  vhfkeyctl combo <CTRL|SHIFT|ALT|WIN> <NAME>\n"
            "  vhfkeyctl probe\n");
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        Usage();
        return 3;
    }

    HANDLE device = OpenDevice();
    if (device == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "virtual keyboard device not found (is the driver installed and started?)\n");
        return 2;
    }

    int result = 0;
    if (_stricmp(argv[1], "probe") == 0) {
        printf("device present\n");
    } else if (_stricmp(argv[1], "type") == 0 && argc >= 3) {
        result = TypeText(device, argv[2]) ? 0 : 1;
    } else if (_stricmp(argv[1], "key") == 0 && argc >= 3) {
        const KeyEntry *key = FindKey(argv[2]);
        if (key == NULL) {
            fprintf(stderr, "unknown key: %s\n", argv[2]);
            result = 4;
        } else {
            result = TapKey(device, key->code, 0) ? 0 : 1;
        }
    } else if (_stricmp(argv[1], "combo") == 0 && argc >= 4) {
        unsigned char modifier = 0;
        if (_stricmp(argv[2], "CTRL") == 0)  modifier = K_CTRL;
        else if (_stricmp(argv[2], "SHIFT") == 0) modifier = K_SHIFT;
        else if (_stricmp(argv[2], "ALT") == 0)   modifier = K_ALT;
        else if (_stricmp(argv[2], "WIN") == 0)   modifier = K_WIN;
        else {
            fprintf(stderr, "unknown modifier: %s\n", argv[2]);
            CloseHandle(device);
            return 4;
        }
        const KeyEntry *key = FindKey(argv[3]);
        if (key == NULL) {
            fprintf(stderr, "unknown key: %s\n", argv[3]);
            result = 4;
        } else {
            // Press the modifier first, so the target sees the chord rather than a bare key followed by
            // a modifier that arrived too late.
            SendReport(device, modifier, 0);
            Sleep(12);
            result = TapKey(device, key->code, modifier) ? 0 : 1;
            SendReport(device, 0, 0);
            Sleep(12);
        }
    } else {
        Usage();
        result = 3;
    }

    CloseHandle(device);
    return result;
}
