/*
 * vhfctl.cpp — user-mode client for the virtual HID keyboard and mouse.
 *
 * Opens the driver's device interface for whichever device an action concerns and sends HID input reports.
 * It carries no HID knowledge beyond the report layouts the driver's descriptors also declare, so the two
 * cannot disagree about a format without one of them failing loudly.
 *
 * Keyboard:
 *   vhfctl type <text>            type literal ASCII text
 *   vhfctl key <name>             press one key by name (ENTER, TAB, A, F5, ...)
 *   vhfctl combo <mod> <name>     hold a modifier while pressing a key (CTRL, SHIFT, ALT, WIN)
 *
 * Mouse:
 *   vhfctl move <x> <y>           move the pointer to an absolute screen position
 *   vhfctl click [x] [y]          click; with coordinates, move there first
 *   vhfctl dblclick [x] [y]       double click
 *   vhfctl down|up [button]       press or release a button (left by default)
 *   vhfctl scroll <notches>       scroll; positive is away from the user
 *
 *   Options: --button <left|right|middle>, --count <n>
 *
 *   vhfctl probe                  report which devices are present
 *
 * Exit codes: 0 success, 2 device not found, 3 bad usage, 4 unrecognised key.
 *
 * Every keystroke is sent as a press report followed by a release report, with a short gap. A keyboard that
 * never releases a key leaves the system convinced the key is held down, which turns one typo into a stuck
 * modifier for the rest of the session. The same applies to a mouse button, so `down` and `up` are separate
 * commands and `click` always sends both.
 */

#include <windows.h>
#include <setupapi.h>
#include <initguid.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "vhfhid.h"

#pragma comment(lib, "setupapi.lib")

/*
 * The pointer is positioned absolutely, over the range the descriptor declares.
 *
 * The range covers the whole virtual desktop, so a pixel coordinate is first made relative to the desktop's
 * origin: on a multi-monitor setup the second monitor has negative coordinates of its own, and mapping those
 * directly would fold them onto the first monitor.
 */
static unsigned short ToAbsolute(int pixel, int origin, int extent)
{
    long value;
    if (extent <= 1) {
        return 0;
    }
    // Multiply before dividing so the intermediate value keeps its precision; dividing first would quantise
    // every position to a multiple of extent/32767 and a full-screen movement would land visibly short.
    value = ((long)(pixel - origin) * VHFMOUSE_ABSOLUTE_MAX) / (extent - 1);
    if (value < 0) value = 0;
    if (value > VHFMOUSE_ABSOLUTE_MAX) value = VHFMOUSE_ABSOLUTE_MAX;
    return (unsigned short)value;
}

static unsigned short AbsX(int pixel)
{
    return ToAbsolute(pixel, GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN));
}

static unsigned short AbsY(int pixel)
{
    return ToAbsolute(pixel, GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN));
}

/*
 * The keyboard report table: PS/2 Set 1 scan codes, which are also the HID keyboard usages for the common
 * keys. The two agree for everything listed here, so one table serves both.
 */
struct KeyEntry {
    const char *name;
    unsigned char code;
};

static const KeyEntry g_Keys[] = {
    { "A", 0x04 }, { "B", 0x05 }, { "C", 0x06 }, { "D", 0x07 }, { "E", 0x08 },
    { "F", 0x09 }, { "G", 0x0A }, { "H", 0x0B }, { "I", 0x0C }, { "J", 0x0D },
    { "K", 0x0E }, { "L", 0x0F }, { "M", 0x10 }, { "N", 0x11 }, { "O", 0x12 },
    { "P", 0x13 }, { "Q", 0x14 }, { "R", 0x15 }, { "S", 0x16 }, { "T", 0x17 },
    { "U", 0x18 }, { "V", 0x19 }, { "W", 0x1A }, { "X", 0x1B }, { "Y", 0x1C },
    { "Z", 0x1D },
    { "1", 0x1E }, { "2", 0x1F }, { "3", 0x20 }, { "4", 0x21 }, { "5", 0x22 },
    { "6", 0x23 }, { "7", 0x24 }, { "8", 0x25 }, { "9", 0x26 }, { "0", 0x27 },
    { "ENTER", 0x28 }, { "ESC", 0x29 }, { "BACKSPACE", 0x2A }, { "TAB", 0x2B },
    { "SPACE", 0x2C }, { "MINUS", 0x2D }, { "EQUAL", 0x2E },
    { "LBRACKET", 0x2F }, { "RBRACKET", 0x30 }, { "BACKSLASH", 0x31 },
    { "SEMICOLON", 0x33 }, { "QUOTE", 0x34 }, { "GRAVE", 0x35 },
    { "COMMA", 0x36 }, { "PERIOD", 0x37 }, { "SLASH", 0x38 },
    { "CAPSLOCK", 0x39 },
    { "F1", 0x3A }, { "F2", 0x3B }, { "F3", 0x3C }, { "F4", 0x3D }, { "F5", 0x3E },
    { "F6", 0x3F }, { "F7", 0x40 }, { "F8", 0x41 }, { "F9", 0x42 }, { "F10", 0x43 },
    { "F11", 0x44 }, { "F12", 0x45 },
    { "DELETE", 0x4C }, { "INSERT", 0x49 }, { "HOME", 0x4A }, { "END", 0x4D },
    { "PAGEUP", 0x4B }, { "PAGEDOWN", 0x4E },
    { "RIGHT", 0x4F }, { "LEFT", 0x50 }, { "DOWN", 0x51 }, { "UP", 0x52 },
};

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
 * A leading K_ avoids the names winuser.h already owns as macros. MOD_ALT, MOD_SHIFT and MOD_CONTROL are
 * defined there as plain integers, so a declaration with one of those names is rewritten by the
 * preprocessor before the compiler sees it and fails as a syntax error on a constant — a message that says
 * nothing about the macro that caused it.
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
 * Find a device by interface GUID.
 *
 * The path is not stable across enumerations, so it is looked up every run rather than cached anywhere.
 */
static HANDLE OpenDevice(const GUID *guid)
{
    HDEVINFO info = SetupDiGetClassDevs(guid, NULL, NULL, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (info == INVALID_HANDLE_VALUE) {
        return INVALID_HANDLE_VALUE;
    }

    SP_DEVICE_INTERFACE_DATA interfaceData;
    interfaceData.cbSize = sizeof(interfaceData);
    HANDLE device = INVALID_HANDLE_VALUE;

    for (DWORD index = 0; SetupDiEnumDeviceInterfaces(info, NULL, guid, index, &interfaceData); ++index) {
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

/* --------------------------------------------------------------------------------------------- */
/* Keyboard                                                                                       */
/* --------------------------------------------------------------------------------------------- */

static bool SendKeyReport(HANDLE device, unsigned char modifier, unsigned char key)
{
    unsigned char report[VHFKEY_REPORT_SIZE];
    DWORD written = 0;
    memset(report, 0, sizeof(report));
    report[VHFKEY_MODIFIER_INDEX] = modifier;
    if (key != 0) {
        report[VHFKEY_KEYS_INDEX] = key;
    }
    return DeviceIoControl(device, IOCTL_VHFKEY_SEND_REPORT, report, sizeof(report), NULL, 0, &written, NULL) != FALSE;
}

/*
 * Press and release one key.
 *
 * The release is always sent, including when the press failed, because a failure after the key has been
 * registered would otherwise leave it held down system-wide.
 */
static bool TapKey(HANDLE device, unsigned char key, unsigned char modifier)
{
    bool pressed = SendKeyReport(device, modifier, key);
    Sleep(12);
    bool released = SendKeyReport(device, 0, 0);
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
        if (!TapKey(device, key->code, entry->shift ? K_SHIFT : 0)) {
            return false;
        }
    }
    return true;
}

/* --------------------------------------------------------------------------------------------- */
/* Mouse                                                                                          */
/* --------------------------------------------------------------------------------------------- */

struct MouseState {
    unsigned char buttons;
    unsigned short x;
    unsigned short y;
};

/** Send one mouse report. Every report carries the full state, so a field left at zero is a release. */
static bool SendMouseReport(HANDLE device, const MouseState *state, signed char wheel)
{
    unsigned char report[VHFMOUSE_REPORT_SIZE];
    DWORD written = 0;
    memset(report, 0, sizeof(report));
    report[VHFMOUSE_BUTTONS_INDEX] = state->buttons;
    // Little-endian, which is how the descriptor's 16-bit fields are laid out.
    report[VHFMOUSE_X_INDEX] = (unsigned char)(state->x & 0xFF);
    report[VHFMOUSE_X_INDEX + 1] = (unsigned char)((state->x >> 8) & 0xFF);
    report[VHFMOUSE_Y_INDEX] = (unsigned char)(state->y & 0xFF);
    report[VHFMOUSE_Y_INDEX + 1] = (unsigned char)((state->y >> 8) & 0xFF);
    report[VHFMOUSE_WHEEL_INDEX] = (unsigned char)wheel;

    if (!DeviceIoControl(device, IOCTL_VHFMOUSE_SEND_REPORT, report, sizeof(report), NULL, 0, &written, NULL)) {
        // The error is reported rather than swallowed: a rejected report and a report that was accepted but
        // had no effect look identical from the outside, and the difference decides where to look next.
        DWORD error = GetLastError();
        fprintf(stderr,
                "mouse report rejected: error %lu, report = %02X %02X %02X %02X %02X %02X (%u bytes)\n",
                error, report[0], report[1], report[2], report[3], report[4], report[5],
                (unsigned)sizeof(report));
        return false;
    }
    return true;
}

static unsigned char ButtonBit(const char *name)
{
    if (name == NULL || _stricmp(name, "left") == 0)   return VHFMOUSE_BUTTON_LEFT;
    if (_stricmp(name, "right") == 0)                  return VHFMOUSE_BUTTON_RIGHT;
    if (_stricmp(name, "middle") == 0)                 return VHFMOUSE_BUTTON_MIDDLE;
    return 0;
}

/*
 * Move the pointer, then act on a button.
 *
 * The position is written into every report including the button ones, because a report is the whole state:
 * a button report that carried a zero position would drag the pointer to the top-left corner on its way to
 * clicking. That is the failure this structure exists to prevent.
 */
static bool ClickAt(HANDLE device, int x, int y, unsigned char button, int count)
{
    MouseState state;
    state.buttons = 0;
    state.x = AbsX(x);
    state.y = AbsY(y);

    if (!SendMouseReport(device, &state, 0)) {
        return false;
    }
    Sleep(20);

    for (int i = 0; i < count; ++i) {
        state.buttons = button;
        if (!SendMouseReport(device, &state, 0)) {
            return false;
        }
        Sleep(20);
        state.buttons = 0;
        if (!SendMouseReport(device, &state, 0)) {
            return false;
        }
        if (i + 1 < count) {
            Sleep(40);
        }
    }
    return true;
}

/* --------------------------------------------------------------------------------------------- */
/* Entry point                                                                                    */
/* --------------------------------------------------------------------------------------------- */

static void Usage(void)
{
    fprintf(stderr,
            "usage:\n"
            "  vhfctl type <text>\n"
            "  vhfctl key <NAME>\n"
            "  vhfctl combo <CTRL|SHIFT|ALT|WIN> <NAME>\n"
            "  vhfctl move <x> <y>\n"
            "  vhfctl click [<x> <y>] [--button left|right|middle] [--count N]\n"
            "  vhfctl dblclick [<x> <y>]\n"
            "  vhfctl down|up [left|right|middle]\n"
            "  vhfctl scroll <notches>\n"
            "  vhfctl probe\n");
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        Usage();
        return 3;
    }

    // Options are pulled out before the positional arguments are read, so they may appear anywhere.
    const char *buttonName = NULL;
    int count = 1;
    int positional[8];
    int positionalCount = 0;
    const char *words[8];
    int wordCount = 0;

    for (int i = 2; i < argc; ++i) {
        if (_stricmp(argv[i], "--button") == 0 && i + 1 < argc) {
            buttonName = argv[++i];
        } else if (_stricmp(argv[i], "--count") == 0 && i + 1 < argc) {
            count = atoi(argv[++i]);
            if (count < 1) count = 1;
        } else if (argv[i][0] == '-' && (argv[i][1] < '0' || argv[i][1] > '9') && argv[i][1] != '\0') {
            // An unrecognised option is a usage error rather than a value, so it is not silently accepted.
            fprintf(stderr, "unknown option: %s\n", argv[i]);
            Usage();
            return 3;
        } else if ((argv[i][0] >= '0' && argv[i][0] <= '9') || (argv[i][0] == '-' && argv[i][1] >= '0' && argv[i][1] <= '9')) {
            if (positionalCount < 8) positional[positionalCount++] = atoi(argv[i]);
        } else {
            if (wordCount < 8) words[wordCount++] = argv[i];
        }
    }

    const char *action = argv[1];

    // --- keyboard ---------------------------------------------------------------------------
    if (_stricmp(action, "type") == 0 || _stricmp(action, "key") == 0 || _stricmp(action, "combo") == 0) {
        HANDLE device = OpenDevice(&GUID_DEVINTERFACE_VHFKEY);
        if (device == INVALID_HANDLE_VALUE) {
            fprintf(stderr, "virtual keyboard device not found (is the driver installed and started?)\n");
            return 2;
        }
        int result = 0;

        if (_stricmp(action, "type") == 0) {
            if (wordCount == 0) { Usage(); CloseHandle(device); return 3; }
            result = TypeText(device, words[0]) ? 0 : 1;
        } else if (_stricmp(action, "key") == 0) {
            if (wordCount == 0) { Usage(); CloseHandle(device); return 3; }
            const KeyEntry *key = FindKey(words[0]);
            if (key == NULL) { fprintf(stderr, "unknown key: %s\n", words[0]); result = 4; }
            else result = TapKey(device, key->code, 0) ? 0 : 1;
        } else {
            if (wordCount < 2) { Usage(); CloseHandle(device); return 3; }
            unsigned char modifier = 0;
            if (_stricmp(words[0], "CTRL") == 0)       modifier = K_CTRL;
            else if (_stricmp(words[0], "SHIFT") == 0) modifier = K_SHIFT;
            else if (_stricmp(words[0], "ALT") == 0)   modifier = K_ALT;
            else if (_stricmp(words[0], "WIN") == 0)   modifier = K_WIN;
            else { fprintf(stderr, "unknown modifier: %s\n", words[0]); CloseHandle(device); return 4; }

            const KeyEntry *key = FindKey(words[1]);
            if (key == NULL) { fprintf(stderr, "unknown key: %s\n", words[1]); result = 4; }
            else {
                // Press the modifier first, so the target sees the chord rather than a bare key followed by a
                // modifier that arrived too late.
                SendKeyReport(device, modifier, 0);
                Sleep(12);
                result = TapKey(device, key->code, modifier) ? 0 : 1;
                SendKeyReport(device, 0, 0);
                Sleep(12);
            }
        }
        CloseHandle(device);
        return result;
    }

    // --- mouse ------------------------------------------------------------------------------
    HANDLE mouse = INVALID_HANDLE_VALUE;
    MouseState state;
    state.buttons = 0;
    state.x = 0;
    state.y = 0;
    int result = 0;

    if (_stricmp(action, "probe") == 0) {
        HANDLE keyboard = OpenDevice(&GUID_DEVINTERFACE_VHFKEY);
        bool hasKeyboard = keyboard != INVALID_HANDLE_VALUE;
        if (hasKeyboard) CloseHandle(keyboard);
        mouse = OpenDevice(&GUID_DEVINTERFACE_VHFMOUSE);
        bool hasMouse = mouse != INVALID_HANDLE_VALUE;
        if (hasMouse) CloseHandle(mouse);
        if (!hasKeyboard && !hasMouse) {
            fprintf(stderr, "neither virtual device found\n");
            return 2;
        }
        printf("devices present: keyboard=%s mouse=%s\n", hasKeyboard ? "yes" : "no", hasMouse ? "yes" : "no");
        return 0;
    }

    mouse = OpenDevice(&GUID_DEVINTERFACE_VHFMOUSE);
    if (mouse == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "virtual mouse device not found (is the driver installed and started?)\n");
        return 2;
    }

    if (_stricmp(action, "move") == 0) {
        if (positionalCount < 2) { Usage(); CloseHandle(mouse); return 3; }
        state.x = AbsX(positional[0]);
        state.y = AbsY(positional[1]);
        result = SendMouseReport(mouse, &state, 0) ? 0 : 1;
    } else if (_stricmp(action, "click") == 0 || _stricmp(action, "dblclick") == 0) {
        int x, y;
        if (positionalCount >= 2) { x = positional[0]; y = positional[1]; }
        else {
            // No coordinates: act wherever the pointer already is, so a caller can click without moving it.
            POINT current;
            if (!GetCursorPos(&current)) { CloseHandle(mouse); return 1; }
            x = current.x;
            y = current.y;
        }
        unsigned char button = ButtonBit(buttonName);
        if (button == 0) {
            fprintf(stderr, "unknown button: %s\n", buttonName ? buttonName : "(null)");
            CloseHandle(mouse);
            return 4;
        }
        int clicks = _stricmp(action, "dblclick") == 0 ? 2 : count;
        result = ClickAt(mouse, x, y, button, clicks) ? 0 : 1;
    } else if (_stricmp(action, "down") == 0 || _stricmp(action, "up") == 0) {
        unsigned char button = ButtonBit(wordCount > 0 ? words[0] : buttonName);
        if (button == 0) { fprintf(stderr, "unknown button\n"); CloseHandle(mouse); return 4; }
        POINT current;
        if (!GetCursorPos(&current)) { CloseHandle(mouse); return 1; }
        state.x = AbsX(current.x);
        state.y = AbsY(current.y);
        state.buttons = _stricmp(action, "down") == 0 ? button : 0;
        result = SendMouseReport(mouse, &state, 0) ? 0 : 1;
    } else if (_stricmp(action, "scroll") == 0) {
        if (positionalCount < 1) { Usage(); CloseHandle(mouse); return 3; }
        POINT current;
        if (!GetCursorPos(&current)) { CloseHandle(mouse); return 1; }
        state.x = AbsX(current.x);
        state.y = AbsY(current.y);
        int notches = positional[0];
        // The declared range is a single signed byte, so a long scroll is sent as several notches. Sending
        // 2400 as one value would wrap to 96 and scroll the wrong way.
        signed char step = notches >= 0 ? 1 : -1;
        for (int i = 0; i < abs(notches); ++i) {
            if (!SendMouseReport(mouse, &state, (signed char)(step * (VHFMOUSE_WHEEL_DELTA / 120)))) {
                result = 1;
                break;
            }
            Sleep(10);
        }
    } else {
        Usage();
        result = 3;
    }

    CloseHandle(mouse);
    return result;
}
