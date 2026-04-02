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

static void SetKey(INPUT* input, WORD vk, DWORD flags) {
    input->type = INPUT_KEYBOARD;
    input->ki.wVk = vk;
    input->ki.wScan = (WORD)MapVirtualKeyA(vk, MAPVK_VK_TO_VSC);
    input->ki.dwFlags = flags;
}

/* Modifier keys that may interfere with SendInput if held by the user's
   hotkey.  We check left/right-specific variants since GetAsyncKeyState
   reports physical key state per side. */
static const WORD MODIFIER_VKS[] = {
    VK_LCONTROL, VK_RCONTROL,
    VK_LSHIFT,   VK_RSHIFT,
    VK_LMENU,    VK_RMENU,
    VK_LWIN,     VK_RWIN,
};
#define NUM_MODIFIERS (sizeof(MODIFIER_VKS) / sizeof(MODIFIER_VKS[0]))

/* Release any modifier keys that are currently held down so they don't
   contaminate the paste keystroke.  Returns the count of keys released;
   the caller must pass the same arrays back to RestoreModifiers(). */
static int ReleaseModifiers(INPUT* released, WORD* releasedVKs) {
    int count = 0;
    for (int i = 0; i < (int)NUM_MODIFIERS; i++) {
        if (GetAsyncKeyState(MODIFIER_VKS[i]) & 0x8000) {
            releasedVKs[count] = MODIFIER_VKS[i];
            SetKey(&released[count], MODIFIER_VKS[i], KEYEVENTF_KEYUP);
            count++;
        }
    }
    if (count > 0) {
        SendInput((UINT)count, released, sizeof(INPUT));
    }
    return count;
}

/* Re-press modifier keys that were released by ReleaseModifiers(). */
static void RestoreModifiers(WORD* releasedVKs, int count) {
    if (count == 0) return;
    INPUT restore[NUM_MODIFIERS];
    ZeroMemory(restore, sizeof(restore));
    for (int i = 0; i < count; i++) {
        SetKey(&restore[i], releasedVKs[i], 0);
    }
    SendInput((UINT)count, restore, sizeof(INPUT));
}

static int SendPasteNormal(void) {
    INPUT inputs[4];
    ZeroMemory(inputs, sizeof(inputs));

    SetKey(&inputs[0], VK_LCONTROL, 0);
    SetKey(&inputs[1], 'V', 0);
    SetKey(&inputs[2], 'V', KEYEVENTF_KEYUP);
    SetKey(&inputs[3], VK_LCONTROL, KEYEVENTF_KEYUP);

    UINT sent = SendInput(4, inputs, sizeof(INPUT));
    return (sent == 4) ? 0 : 1;
}

static int SendPasteTerminal(void) {
    INPUT inputs[6];
    ZeroMemory(inputs, sizeof(inputs));

    SetKey(&inputs[0], VK_LCONTROL, 0);
    SetKey(&inputs[1], VK_LSHIFT, 0);
    SetKey(&inputs[2], 'V', 0);
    SetKey(&inputs[3], 'V', KEYEVENTF_KEYUP);
    SetKey(&inputs[4], VK_LSHIFT, KEYEVENTF_KEYUP);
    SetKey(&inputs[5], VK_LCONTROL, KEYEVENTF_KEYUP);

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

    Sleep(10);

    /* Release any modifier keys held by the user's hotkey so they don't
       contaminate the paste keystroke (e.g. Ctrl+Win held → Ctrl+Win+V). */
    INPUT releasedInputs[NUM_MODIFIERS];
    WORD  releasedVKs[NUM_MODIFIERS];
    ZeroMemory(releasedInputs, sizeof(releasedInputs));
    int releasedCount = ReleaseModifiers(releasedInputs, releasedVKs);

    int result;
    if (isTerminal) {
        result = SendPasteTerminal();
    } else {
        result = SendPasteNormal();
    }

    RestoreModifiers(releasedVKs, releasedCount);

    if (result != 0) {
        fprintf(stderr, "ERROR: SendInput failed (error %lu)\n", GetLastError());
        return 1;
    }

    Sleep(20);

    printf("PASTE_OK %s %s\n", className, isTerminal ? "ctrl+shift+v" : "ctrl+v");
    fflush(stdout);

    return 0;
}
