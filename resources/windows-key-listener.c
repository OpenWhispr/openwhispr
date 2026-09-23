/**
 * Windows Key Listener for Push-to-Talk
 *
 * Uses Windows Low-Level Keyboard Hook to detect key up/down events.
 * Accepts a virtual key code as command line argument.
 * Outputs "KEY_DOWN" and "KEY_UP" to stdout.
 *
 * Compile with: cl /O2 windows-key-listener.c /Fe:windows-key-listener.exe user32.lib
 * Or with MinGW: gcc -O2 windows-key-listener.c -o windows-key-listener.exe -luser32
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static HHOOK g_hook = NULL;
static DWORD g_targetVk = 0;
static BOOL g_isKeyDown = FALSE;

// Modifier key requirements
static BOOL g_requireCtrl = FALSE;
static BOOL g_requireAlt = FALSE;
static BOOL g_requireShift = FALSE;
static BOOL g_requireWin = FALSE;
static BOOL g_useModifiersOnly = FALSE;
static BOOL g_ctrlDown = FALSE;
static BOOL g_altDown = FALSE;
static BOOL g_shiftDown = FALSE;
static BOOL g_leftWinDown = FALSE;
static BOOL g_rightWinDown = FALSE;

static BOOL IsCtrlVk(DWORD vkCode) {
    return vkCode == VK_CONTROL || vkCode == VK_LCONTROL || vkCode == VK_RCONTROL;
}

static BOOL IsAltVk(DWORD vkCode) {
    return vkCode == VK_MENU || vkCode == VK_LMENU || vkCode == VK_RMENU;
}

static BOOL IsShiftVk(DWORD vkCode) {
    return vkCode == VK_SHIFT || vkCode == VK_LSHIFT || vkCode == VK_RSHIFT;
}

static BOOL IsWinVk(DWORD vkCode) {
    return vkCode == VK_LWIN || vkCode == VK_RWIN;
}

static void UpdateModifierState(DWORD vkCode, BOOL isKeyDown) {
    if (IsCtrlVk(vkCode)) {
        g_ctrlDown = isKeyDown;
        return;
    }

    if (IsAltVk(vkCode)) {
        g_altDown = isKeyDown;
        return;
    }

    if (IsShiftVk(vkCode)) {
        g_shiftDown = isKeyDown;
        return;
    }

    if (vkCode == VK_LWIN) {
        g_leftWinDown = isKeyDown;
        return;
    }

    if (vkCode == VK_RWIN) {
        g_rightWinDown = isKeyDown;
    }
}

static BOOL IsRequiredModifierEvent(DWORD vkCode) {
    return (g_requireCtrl && IsCtrlVk(vkCode)) ||
           (g_requireAlt && IsAltVk(vkCode)) ||
           (g_requireShift && IsShiftVk(vkCode)) ||
           (g_requireWin && IsWinVk(vkCode));
}

// Sync tracked modifier state with actual key state for keys that are NOT
// the current hook event. GetAsyncKeyState() is unreliable for the key that
// triggered the current hook callback, but accurate for all other keys.
// This corrects stale state caused by missed key-up events (e.g. Win+L lock).
static void SyncModifierState(DWORD currentVkCode) {
    if (!IsCtrlVk(currentVkCode))
        g_ctrlDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    if (!IsAltVk(currentVkCode))
        g_altDown = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
    if (!IsShiftVk(currentVkCode))
        g_shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
    if (currentVkCode != VK_LWIN)
        g_leftWinDown = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0;
    if (currentVkCode != VK_RWIN)
        g_rightWinDown = (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
}

static BOOL AreRequiredModifiersPressed(void) {
    if (g_requireCtrl && !g_ctrlDown) return FALSE;
    if (g_requireAlt && !g_altDown) return FALSE;
    if (g_requireShift && !g_shiftDown) return FALSE;
    if (g_requireWin && !(g_leftWinDown || g_rightWinDown)) return FALSE;
    return TRUE;
}

// BEGIN hotkey-parser
// Contract-tested: test/helpers/nativeListenerKeyVocabulary.test.js compiles
// exactly this block (BEGIN to END) with a POSIX cc against a stub windows.h
// and runs every key name the Settings capture screen can emit through
// ParseHotkeySpec. Keep it self-contained: libc, DWORD/BOOL and VK_* only —
// no listener globals, no Win32 calls.
//
// The vocabulary must match CODE_TO_KEY in src/utils/hotkeyKeyNames.ts. A name
// missing here used to parse as VK 0 and be read as "modifiers only", so
// "Control+Alt+Up" silently became a bare Control+Alt listener that fired on
// the modifiers alone. An unknown name now refuses the whole spec instead.

typedef struct {
    BOOL requireCtrl;
    BOOL requireAlt;
    BOOL requireShift;
    BOOL requireWin;
    BOOL modifiersOnly;     // modifiers named and no regular key (e.g. Control+Super)
    DWORD vk;               // the regular key; 0 when modifiersOnly
    char unknownToken[64];  // the offending token when ParseHotkeySpec returns FALSE
} HotkeySpec;

typedef struct {
    const char* name;
    DWORD vk;
} KeyNameEntry;

// Case-insensitive names. Single characters (letters, digits, punctuation) are
// handled below, not here.
static const KeyNameEntry KEY_NAMES[] = {
    // Function keys
    {"F1", VK_F1},   {"F2", VK_F2},   {"F3", VK_F3},   {"F4", VK_F4},   {"F5", VK_F5},
    {"F6", VK_F6},   {"F7", VK_F7},   {"F8", VK_F8},   {"F9", VK_F9},   {"F10", VK_F10},
    {"F11", VK_F11}, {"F12", VK_F12}, {"F13", VK_F13}, {"F14", VK_F14}, {"F15", VK_F15},
    {"F16", VK_F16}, {"F17", VK_F17}, {"F18", VK_F18}, {"F19", VK_F19}, {"F20", VK_F20},
    {"F21", VK_F21}, {"F22", VK_F22}, {"F23", VK_F23}, {"F24", VK_F24},
    // Whitespace, editing and navigation
    {"Space", VK_SPACE},
    {"Escape", VK_ESCAPE},      {"Esc", VK_ESCAPE},
    {"Tab", VK_TAB},
    {"Enter", VK_RETURN},       {"Return", VK_RETURN},
    {"Backspace", VK_BACK},
    {"Delete", VK_DELETE},      {"Del", VK_DELETE},
    {"Insert", VK_INSERT},
    {"Home", VK_HOME},          {"End", VK_END},
    {"PageUp", VK_PRIOR},       {"PageDown", VK_NEXT},
    {"Up", VK_UP},              {"Down", VK_DOWN},
    {"Left", VK_LEFT},          {"Right", VK_RIGHT},
    // Lock and system keys
    {"CapsLock", VK_CAPITAL},   {"NumLock", VK_NUMLOCK},
    {"ScrollLock", VK_SCROLL},  {"Pause", VK_PAUSE},
    {"PrintScreen", VK_SNAPSHOT},
    // Numpad. Windows reports these virtual keys only while NumLock is on;
    // with it off the same physical keys arrive as Home/Up/PageUp etc.
    {"num0", VK_NUMPAD0}, {"num1", VK_NUMPAD1}, {"num2", VK_NUMPAD2}, {"num3", VK_NUMPAD3},
    {"num4", VK_NUMPAD4}, {"num5", VK_NUMPAD5}, {"num6", VK_NUMPAD6}, {"num7", VK_NUMPAD7},
    {"num8", VK_NUMPAD8}, {"num9", VK_NUMPAD9},
    {"numadd", VK_ADD},   {"numsub", VK_SUBTRACT}, {"nummult", VK_MULTIPLY},
    {"numdiv", VK_DIVIDE}, {"numdec", VK_DECIMAL},
    // Media keys
    {"MediaPlayPause", VK_MEDIA_PLAY_PAUSE}, {"MediaStop", VK_MEDIA_STOP},
    {"MediaNextTrack", VK_MEDIA_NEXT_TRACK}, {"MediaPreviousTrack", VK_MEDIA_PREV_TRACK},
    // Right-side modifiers bound on their own as single-key hotkeys
    {"RightAlt", VK_RMENU},        {"RightOption", VK_RMENU},
    {"RightControl", VK_RCONTROL}, {"RightCtrl", VK_RCONTROL},
    {"RightShift", VK_RSHIFT},
    {"RightSuper", VK_RWIN}, {"RightWin", VK_RWIN}, {"RightMeta", VK_RWIN},
    {"RightCommand", VK_RWIN}, {"RightCmd", VK_RWIN},
    // Named punctuation
    {"Backquote", VK_OEM_3}, {"Minus", VK_OEM_MINUS}, {"Equal", VK_OEM_PLUS},
};

// Map a key name to its virtual-key code; 0 when the name is unknown.
static DWORD ParseKeyCode(const char* keyName) {
    size_t i;
    for (i = 0; i < sizeof(KEY_NAMES) / sizeof(KEY_NAMES[0]); i++) {
        if (_stricmp(keyName, KEY_NAMES[i].name) == 0) return KEY_NAMES[i].vk;
    }

    if (strlen(keyName) == 1) {
        char c = keyName[0];
        if (c >= 'a' && c <= 'z') return (DWORD)(c - 'a' + 'A');
        if (c >= 'A' && c <= 'Z') return (DWORD)c;
        if (c >= '0' && c <= '9') return (DWORD)c;
        switch (c) {
            case '`':  return VK_OEM_3;
            case '-':  return VK_OEM_MINUS;
            case '=':  return VK_OEM_PLUS;
            case '[':  return VK_OEM_4;
            case ']':  return VK_OEM_6;
            case '\\': return VK_OEM_5;
            case ';':  return VK_OEM_1;
            case '\'': return VK_OEM_7;
            case ',':  return VK_OEM_COMMA;
            case '.':  return VK_OEM_PERIOD;
            case '/':  return VK_OEM_2;
            default:   return 0;
        }
    }

    // A raw virtual-key code, hex ("0x41") or decimal ("65"). The whole token
    // must be a number in 1..255: atoi() used to turn any garbage into VK 0.
    {
        char* end = NULL;
        int hex = keyName[0] == '0' && (keyName[1] == 'x' || keyName[1] == 'X');
        long value = strtol(keyName, &end, hex ? 16 : 10);
        if (end != keyName && *end == '\0' && value > 0 && value < 256) return (DWORD)value;
    }

    return 0;
}

// Consume a modifier token into the spec. Returns FALSE when the token is not
// a modifier, so the caller treats it as the regular key.
static BOOL ParseModifierToken(const char* token, HotkeySpec* spec) {
    if (_stricmp(token, "CommandOrControl") == 0 || _stricmp(token, "Control") == 0 ||
        _stricmp(token, "Ctrl") == 0 || _stricmp(token, "CmdOrCtrl") == 0) {
        spec->requireCtrl = TRUE;
    } else if (_stricmp(token, "Alt") == 0 || _stricmp(token, "Option") == 0) {
        spec->requireAlt = TRUE;
    } else if (_stricmp(token, "Shift") == 0) {
        spec->requireShift = TRUE;
    } else if (_stricmp(token, "Super") == 0 || _stricmp(token, "Meta") == 0 ||
               _stricmp(token, "Win") == 0 || _stricmp(token, "Command") == 0 ||
               _stricmp(token, "Cmd") == 0) {
        spec->requireWin = TRUE;
    } else {
        return FALSE;
    }
    return TRUE;
}

static void RecordUnknownToken(HotkeySpec* spec, const char* token) {
    strncpy(spec->unknownToken, token, sizeof(spec->unknownToken) - 1);
    spec->unknownToken[sizeof(spec->unknownToken) - 1] = '\0';
}

// Parse a hotkey like "CommandOrControl+Shift+F11", "Control+Super" or "F8"
// into `out`. Returns FALSE — with `out->unknownToken` set when a token is the
// cause — for an unknown key name, two regular keys, a dangling "+", or an
// empty string. A failed parse never yields a modifiers-only spec.
static BOOL ParseHotkeySpec(const char* hotkey, HotkeySpec* out) {
    char buffer[256];
    char* token;
    size_t len;

    memset(out, 0, sizeof(*out));
    if (hotkey == NULL) return FALSE;

    strncpy(buffer, hotkey, sizeof(buffer) - 1);
    buffer[sizeof(buffer) - 1] = '\0';

    // Trim the whole string, then refuse a leading or trailing "+": strtok
    // would drop the empty token and read "Control+Alt+" as modifiers-only.
    len = strlen(buffer);
    while (len > 0 && buffer[len - 1] == ' ') buffer[--len] = '\0';
    if (len == 0) return FALSE;
    if (buffer[0] == '+' || buffer[len - 1] == '+') return FALSE;

    token = strtok(buffer, "+");
    while (token != NULL) {
        char* end;
        while (*token == ' ') token++;
        end = token + strlen(token) - 1;
        while (end > token && *end == ' ') *end-- = '\0';

        if (!ParseModifierToken(token, out)) {
            DWORD vk = ParseKeyCode(token);
            if (vk == 0 || out->vk != 0) {
                RecordUnknownToken(out, token);
                out->vk = 0;
                return FALSE;
            }
            out->vk = vk;
        }

        token = strtok(NULL, "+");
    }

    if (out->vk == 0) {
        if (!(out->requireCtrl || out->requireAlt || out->requireShift || out->requireWin)) {
            return FALSE;
        }
        out->modifiersOnly = TRUE;
    }
    return TRUE;
}
// END hotkey-parser

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        KBDLLHOOKSTRUCT* kbd = (KBDLLHOOKSTRUCT*)lParam;
        BOOL isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
        BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);
        BOOL isModifierEvent = IsCtrlVk(kbd->vkCode) || IsAltVk(kbd->vkCode) ||
                               IsShiftVk(kbd->vkCode) || IsWinVk(kbd->vkCode);

        if ((isKeyDown || isKeyUp) && isModifierEvent) {
            UpdateModifierState(kbd->vkCode, isKeyDown);
            SyncModifierState(kbd->vkCode);
        }

        // Stop an active press as soon as one of its required modifiers is released.
        if (g_isKeyDown && isKeyUp && IsRequiredModifierEvent(kbd->vkCode) &&
            !AreRequiredModifiersPressed()) {
            g_isKeyDown = FALSE;
            printf("KEY_UP\n");
            fflush(stdout);
        }

        // Self-heal a missed target-key KEY_UP. GetAsyncKeyState is only reliable
        // for keys other than the one in the current callback, so verify here.
        if (g_isKeyDown && !g_useModifiersOnly && kbd->vkCode != g_targetVk &&
            !(GetAsyncKeyState(g_targetVk) & 0x8000)) {
            g_isKeyDown = FALSE;
            printf("KEY_UP\n");
            fflush(stdout);
        }

        if (g_useModifiersOnly) {
            if (isKeyDown) {
                if (!g_isKeyDown && AreRequiredModifiersPressed()) {
                    g_isKeyDown = TRUE;
                    printf("KEY_DOWN\n");
                    fflush(stdout);
                }
            } else if (isKeyUp) {
                if (g_isKeyDown && !AreRequiredModifiersPressed()) {
                    g_isKeyDown = FALSE;
                    printf("KEY_UP\n");
                    fflush(stdout);
                }
            }
            return CallNextHookEx(g_hook, nCode, wParam, lParam);
        }

        // Check for the target key
        if (kbd->vkCode == g_targetVk) {
            if (isKeyDown) {
                // Only trigger if modifiers are satisfied and not already down
                if (!g_isKeyDown && AreRequiredModifiersPressed()) {
                    g_isKeyDown = TRUE;
                    printf("KEY_DOWN\n");
                    fflush(stdout);
                }
            } else if (isKeyUp) {
                // Target key released
                if (g_isKeyDown) {
                    g_isKeyDown = FALSE;
                    printf("KEY_UP\n");
                    fflush(stdout);
                }
            }
        }
    }
    return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

BOOL WINAPI ConsoleHandler(DWORD signal) {
    if (signal == CTRL_C_EVENT || signal == CTRL_BREAK_EVENT || signal == CTRL_CLOSE_EVENT) {
        if (g_hook) {
            UnhookWindowsHookEx(g_hook);
            g_hook = NULL;
        }
        ExitProcess(0);
    }
    return TRUE;
}

int main(int argc, char* argv[]) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <key>\n", argv[0]);
        fprintf(stderr, "Examples:\n");
        fprintf(stderr, "  %s `                        (backtick)\n", argv[0]);
        fprintf(stderr, "  %s F8                       (function key F1-F12)\n", argv[0]);
        fprintf(stderr, "  %s F13                      (extended function key F13-F24)\n", argv[0]);
        fprintf(stderr, "  %s CommandOrControl+F11     (with modifier)\n", argv[0]);
        fprintf(stderr, "  %s Ctrl+Shift+Space         (multiple modifiers)\n", argv[0]);
        fprintf(stderr, "  %s Control+Super            (modifier-only combo)\n", argv[0]);
        return 1;
    }

    HotkeySpec spec;
    if (!ParseHotkeySpec(argv[1], &spec)) {
        if (spec.unknownToken[0] != '\0') {
            fprintf(stderr, "Error: unrecognized key '%s' in hotkey '%s'\n", spec.unknownToken, argv[1]);
        } else {
            fprintf(stderr, "Error: Invalid key '%s'\n", argv[1]);
        }
        return 1;
    }
    g_targetVk = spec.vk;
    g_requireCtrl = spec.requireCtrl;
    g_requireAlt = spec.requireAlt;
    g_requireShift = spec.requireShift;
    g_requireWin = spec.requireWin;
    g_useModifiersOnly = spec.modifiersOnly;

    // Log what we're listening for
    fprintf(stderr, "Listening for: %s (VK=0x%02X, Ctrl=%d, Alt=%d, Shift=%d, Win=%d, ModOnly=%d)\n",
            argv[1], g_targetVk, g_requireCtrl, g_requireAlt, g_requireShift, g_requireWin, g_useModifiersOnly);

    // Set up console handler for clean shutdown
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);

    // Install the low-level keyboard hook
    g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc, NULL, 0);
    if (!g_hook) {
        fprintf(stderr, "Error: Failed to install keyboard hook (error %lu)\n", GetLastError());
        return 1;
    }

    // Signal that we're ready
    printf("READY\n");
    fflush(stdout);

    // Message loop - required for low-level hooks to work
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    UnhookWindowsHookEx(g_hook);
    return 0;
}
