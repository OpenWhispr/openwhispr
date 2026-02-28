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

// Check if required modifiers are currently pressed
BOOL AreModifiersPressed(void) {
    if (g_requireCtrl && !(GetAsyncKeyState(VK_CONTROL) & 0x8000)) return FALSE;
    if (g_requireAlt && !(GetAsyncKeyState(VK_MENU) & 0x8000)) return FALSE;
    if (g_requireShift && !(GetAsyncKeyState(VK_SHIFT) & 0x8000)) return FALSE;
    if (g_requireWin &&
        !(GetAsyncKeyState(VK_LWIN) & 0x8000) &&
        !(GetAsyncKeyState(VK_RWIN) & 0x8000)) {
        return FALSE;
    }
    return TRUE;
}

// Map key name to virtual key code
DWORD ParseKeyCode(const char* keyName) {
    // Function keys (F1-F12)
    if (_stricmp(keyName, "F1") == 0) return VK_F1;
    if (_stricmp(keyName, "F2") == 0) return VK_F2;
    if (_stricmp(keyName, "F3") == 0) return VK_F3;
    if (_stricmp(keyName, "F4") == 0) return VK_F4;
    if (_stricmp(keyName, "F5") == 0) return VK_F5;
    if (_stricmp(keyName, "F6") == 0) return VK_F6;
    if (_stricmp(keyName, "F7") == 0) return VK_F7;
    if (_stricmp(keyName, "F8") == 0) return VK_F8;
    if (_stricmp(keyName, "F9") == 0) return VK_F9;
    if (_stricmp(keyName, "F10") == 0) return VK_F10;
    if (_stricmp(keyName, "F11") == 0) return VK_F11;
    if (_stricmp(keyName, "F12") == 0) return VK_F12;

    // Extended function keys (F13-F24)
    if (_stricmp(keyName, "F13") == 0) return VK_F13;
    if (_stricmp(keyName, "F14") == 0) return VK_F14;
    if (_stricmp(keyName, "F15") == 0) return VK_F15;
    if (_stricmp(keyName, "F16") == 0) return VK_F16;
    if (_stricmp(keyName, "F17") == 0) return VK_F17;
    if (_stricmp(keyName, "F18") == 0) return VK_F18;
    if (_stricmp(keyName, "F19") == 0) return VK_F19;
    if (_stricmp(keyName, "F20") == 0) return VK_F20;
    if (_stricmp(keyName, "F21") == 0) return VK_F21;
    if (_stricmp(keyName, "F22") == 0) return VK_F22;
    if (_stricmp(keyName, "F23") == 0) return VK_F23;
    if (_stricmp(keyName, "F24") == 0) return VK_F24;

    // Special keys
    if (_stricmp(keyName, "Pause") == 0) return VK_PAUSE;
    if (_stricmp(keyName, "ScrollLock") == 0) return VK_SCROLL;
    if (_stricmp(keyName, "Insert") == 0) return VK_INSERT;
    if (_stricmp(keyName, "Home") == 0) return VK_HOME;
    if (_stricmp(keyName, "End") == 0) return VK_END;
    if (_stricmp(keyName, "PageUp") == 0) return VK_PRIOR;
    if (_stricmp(keyName, "PageDown") == 0) return VK_NEXT;
    if (_stricmp(keyName, "Space") == 0) return VK_SPACE;
    if (_stricmp(keyName, "Escape") == 0 || _stricmp(keyName, "Esc") == 0) return VK_ESCAPE;
    if (_stricmp(keyName, "Tab") == 0) return VK_TAB;
    if (_stricmp(keyName, "CapsLock") == 0) return VK_CAPITAL;
    if (_stricmp(keyName, "NumLock") == 0) return VK_NUMLOCK;

    // Right-side modifier keys (used as single-key hotkeys)
    if (_stricmp(keyName, "RightAlt") == 0 || _stricmp(keyName, "RightOption") == 0) return VK_RMENU;
    if (_stricmp(keyName, "RightControl") == 0 || _stricmp(keyName, "RightCtrl") == 0) return VK_RCONTROL;
    if (_stricmp(keyName, "RightShift") == 0) return VK_RSHIFT;
    if (_stricmp(keyName, "RightSuper") == 0 || _stricmp(keyName, "RightWin") == 0 ||
        _stricmp(keyName, "RightMeta") == 0 || _stricmp(keyName, "RightCommand") == 0 ||
        _stricmp(keyName, "RightCmd") == 0) return VK_RWIN;

    // Backtick/tilde - the default hotkey
    if (strcmp(keyName, "`") == 0 || _stricmp(keyName, "Backquote") == 0) return VK_OEM_3;

    // Other punctuation
    if (strcmp(keyName, "-") == 0 || _stricmp(keyName, "Minus") == 0) return VK_OEM_MINUS;
    if (strcmp(keyName, "=") == 0 || _stricmp(keyName, "Equal") == 0) return VK_OEM_PLUS;
    if (strcmp(keyName, "[") == 0) return VK_OEM_4;
    if (strcmp(keyName, "]") == 0) return VK_OEM_6;
    if (strcmp(keyName, "\\") == 0) return VK_OEM_5;
    // Circumflex/caret dead key (German QWERTZ keyboard: top-left key)
    if (strcmp(keyName, "^") == 0 || _stricmp(keyName, "Caret") == 0) return VK_OEM_5;
    if (strcmp(keyName, ";") == 0) return VK_OEM_1;
    if (strcmp(keyName, "'") == 0) return VK_OEM_7;
    if (strcmp(keyName, ",") == 0) return VK_OEM_COMMA;
    if (strcmp(keyName, ".") == 0) return VK_OEM_PERIOD;
    if (strcmp(keyName, "/") == 0) return VK_OEM_2;

    // Single letter/number - convert to VK code
    if (strlen(keyName) == 1) {
        char c = keyName[0];
        if (c >= 'a' && c <= 'z') return (DWORD)(c - 'a' + 'A');
        if (c >= 'A' && c <= 'Z') return (DWORD)c;
        if (c >= '0' && c <= '9') return (DWORD)c;
    }

    // Try parsing as hex or decimal number (for direct VK codes)
    if (keyName[0] == '0' && (keyName[1] == 'x' || keyName[1] == 'X')) {
        return (DWORD)strtol(keyName, NULL, 16);
    }

    return (DWORD)atoi(keyName);
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode == HC_ACTION) {
        KBDLLHOOKSTRUCT* kbd = (KBDLLHOOKSTRUCT*)lParam;
        BOOL isKeyDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
        BOOL isKeyUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);

        // Check if a required modifier was released while we're in key-down state
        if (g_isKeyDown && isKeyUp) {
            BOOL modifierReleased = FALSE;
            if (g_requireCtrl && (kbd->vkCode == VK_CONTROL || kbd->vkCode == VK_LCONTROL || kbd->vkCode == VK_RCONTROL)) {
                modifierReleased = TRUE;
            }
            if (g_requireAlt && (kbd->vkCode == VK_MENU || kbd->vkCode == VK_LMENU || kbd->vkCode == VK_RMENU)) {
                modifierReleased = TRUE;
            }
            if (g_requireShift && (kbd->vkCode == VK_SHIFT || kbd->vkCode == VK_LSHIFT || kbd->vkCode == VK_RSHIFT)) {
                modifierReleased = TRUE;
            }
            if (g_requireWin && (kbd->vkCode == VK_LWIN || kbd->vkCode == VK_RWIN)) {
                modifierReleased = TRUE;
            }
            if (modifierReleased) {
                g_isKeyDown = FALSE;
                printf("KEY_UP\n");
                fflush(stdout);
            }
        }

        if (g_useModifiersOnly) {
            if (isKeyDown) {
                if (!g_isKeyDown && AreModifiersPressed()) {
                    g_isKeyDown = TRUE;
                    printf("KEY_DOWN\n");
                    fflush(stdout);
                }
            } else if (isKeyUp) {
                if (g_isKeyDown && !AreModifiersPressed()) {
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
                // Only trigger if modifiers are satisfied
                if (AreModifiersPressed()) {
                    if (!g_isKeyDown) {
                        g_isKeyDown = TRUE;
                        printf("KEY_DOWN\n");
                        fflush(stdout);
                    }
                    // Swallow the key event so it doesn't reach the foreground app
                    // (prevents dead keys like ^ from leaking into text fields)
                    return 1;
                }
            } else if (isKeyUp) {
                // Target key released - swallow if we captured the key-down
                if (g_isKeyDown) {
                    g_isKeyDown = FALSE;
                    printf("KEY_UP\n");
                    fflush(stdout);
                    return 1;
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

// Parse a compound hotkey like "CommandOrControl+Shift+F11"
// Sets g_requireCtrl, g_requireAlt, g_requireShift and returns the main key VK code
DWORD ParseCompoundHotkey(const char* hotkey) {
    char buffer[256];
    strncpy(buffer, hotkey, sizeof(buffer) - 1);
    buffer[sizeof(buffer) - 1] = '\0';

    // Reset modifier requirements
    g_requireCtrl = FALSE;
    g_requireAlt = FALSE;
    g_requireShift = FALSE;
    g_requireWin = FALSE;
    g_useModifiersOnly = FALSE;

    DWORD mainKeyVk = 0;
    char* token = strtok(buffer, "+");

    while (token != NULL) {
        // Trim leading/trailing spaces
        while (*token == ' ') token++;
        char* end = token + strlen(token) - 1;
        while (end > token && *end == ' ') *end-- = '\0';

        // Check for modifiers
        if (_stricmp(token, "CommandOrControl") == 0 ||
            _stricmp(token, "Control") == 0 ||
            _stricmp(token, "Ctrl") == 0 ||
            _stricmp(token, "CmdOrCtrl") == 0) {
            g_requireCtrl = TRUE;
        } else if (_stricmp(token, "Alt") == 0 ||
                   _stricmp(token, "Option") == 0) {
            g_requireAlt = TRUE;
        } else if (_stricmp(token, "Shift") == 0) {
            g_requireShift = TRUE;
        } else if (_stricmp(token, "Super") == 0 ||
                   _stricmp(token, "Meta") == 0 ||
                   _stricmp(token, "Win") == 0 ||
                   _stricmp(token, "Command") == 0 ||
                   _stricmp(token, "Cmd") == 0) {
            // Windows key
            g_requireWin = TRUE;
        } else {
            // This should be the main key
            mainKeyVk = ParseKeyCode(token);
        }

        token = strtok(NULL, "+");
    }

    return mainKeyVk;
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
        return 1;
    }

    g_targetVk = ParseCompoundHotkey(argv[1]);
    if (g_targetVk == 0 && (g_requireCtrl || g_requireAlt || g_requireShift || g_requireWin)) {
        g_useModifiersOnly = TRUE;
    }

    if (g_targetVk == 0 && !g_useModifiersOnly) {
        fprintf(stderr, "Error: Invalid key '%s'\n", argv[1]);
        return 1;
    }

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
