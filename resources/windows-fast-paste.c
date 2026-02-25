/**
 * Windows Fast Paste for OpenWhispr
 *
 * Detects the foreground window, checks if it's a terminal emulator,
 * and simulates the appropriate paste keystroke using Win32 SendInput:
 *   - Ctrl+V for normal applications
 *   - Ctrl+Shift+V for terminal emulators
 *
 * Terminal detection uses two strategies:
 *   1. Window class name (fast, works for native terminals)
 *   2. Executable name (fallback, catches Electron-based terminals like Termius)
 *
 * Compile with: cl /O2 windows-fast-paste.c /Fe:windows-fast-paste.exe user32.lib
 * Or with MinGW: gcc -O2 windows-fast-paste.c -o windows-fast-paste.exe -luser32
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

static const char* TERMINAL_CLASSES[] = {
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "mintty",
    "VirtualConsoleClass",
    "PuTTY",
    "Alacritty",
    "org.wezfurlong.wezterm",
    "Hyper",
    "TMobaXterm",
    "kitty",
    NULL
};

/* Electron-based terminals share Chrome_WidgetWin_1 as window class,
   so we detect them by executable name instead */
static const char* TERMINAL_EXES[] = {
    "termius.exe",
    "tabby.exe",
    "wave.exe",
    "rio.exe",
    NULL
};

static BOOL IsTerminalClass(const char* className) {
    for (int i = 0; TERMINAL_CLASSES[i] != NULL; i++) {
        if (_stricmp(className, TERMINAL_CLASSES[i]) == 0) {
            return TRUE;
        }
    }
    return FALSE;
}

static BOOL GetExeName(HWND hwnd, char* exeName, DWORD exeNameSize) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return FALSE;

    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProcess) return FALSE;

    char exePath[MAX_PATH];
    DWORD pathLen = MAX_PATH;
    BOOL ok = QueryFullProcessImageNameA(hProcess, 0, exePath, &pathLen);
    CloseHandle(hProcess);

    if (!ok || pathLen == 0) return FALSE;

    const char* baseName = strrchr(exePath, '\\');
    baseName = baseName ? baseName + 1 : exePath;

    strncpy(exeName, baseName, exeNameSize - 1);
    exeName[exeNameSize - 1] = '\0';
    return TRUE;
}

static BOOL IsTerminalExe(const char* exeName) {
    for (int i = 0; TERMINAL_EXES[i] != NULL; i++) {
        if (_stricmp(exeName, TERMINAL_EXES[i]) == 0) {
            return TRUE;
        }
    }
    return FALSE;
}

static int SendPasteNormal(void) {
    INPUT inputs[4];
    ZeroMemory(inputs, sizeof(inputs));

    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 'V';

    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = 'V';
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;

    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

    UINT sent = SendInput(4, inputs, sizeof(INPUT));
    return (sent == 4) ? 0 : 1;
}

static int SendPasteTerminal(void) {
    INPUT inputs[6];
    ZeroMemory(inputs, sizeof(inputs));

    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;

    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_SHIFT;

    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = 'V';

    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = 'V';
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

    inputs[4].type = INPUT_KEYBOARD;
    inputs[4].ki.wVk = VK_SHIFT;
    inputs[4].ki.dwFlags = KEYEVENTF_KEYUP;

    inputs[5].type = INPUT_KEYBOARD;
    inputs[5].ki.wVk = VK_CONTROL;
    inputs[5].ki.dwFlags = KEYEVENTF_KEYUP;

    UINT sent = SendInput(6, inputs, sizeof(INPUT));
    return (sent == 6) ? 0 : 1;
}

int main(int argc, char* argv[]) {
    BOOL detectOnly = FALSE;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--detect-only") == 0) {
            detectOnly = TRUE;
        }
    }

    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        fprintf(stderr, "ERROR: No foreground window found\n");
        return 2;
    }

    char className[256];
    int classLen = GetClassNameA(hwnd, className, sizeof(className));
    if (classLen == 0) {
        fprintf(stderr, "ERROR: Could not get window class name (error %lu)\n", GetLastError());
        return 1;
    }

    BOOL isTerminal = IsTerminalClass(className);

    char exeName[MAX_PATH] = {0};
    BOOL gotExeName = GetExeName(hwnd, exeName, sizeof(exeName));

    if (!isTerminal && gotExeName) {
        isTerminal = IsTerminalExe(exeName);
    }

    if (detectOnly) {
        printf("WINDOW_CLASS %s\n", className);
        if (gotExeName) {
            printf("EXE_NAME %s\n", exeName);
        }
        printf("IS_TERMINAL %s\n", isTerminal ? "true" : "false");
        fflush(stdout);
        return 0;
    }

    Sleep(5);

    int result;
    if (isTerminal) {
        result = SendPasteTerminal();
    } else {
        result = SendPasteNormal();
    }

    if (result != 0) {
        fprintf(stderr, "ERROR: SendInput failed (error %lu)\n", GetLastError());
        return 1;
    }

    Sleep(20);

    printf("PASTE_OK %s %s\n", className, isTerminal ? "ctrl+shift+v" : "ctrl+v");
    fflush(stdout);

    return 0;
}
