/**
 * Windows Context Capture for OpenWhispr
 *
 * Captures the foreground window's title and process executable name,
 * outputting them as JSON for the IDE context awareness feature.
 *
 * Output: {"appName":"Code.exe","windowTitle":"file.ts — proj — Visual Studio Code"}
 *
 * Compile with: cl /O2 windows-context-capture.c /Fe:windows-context-capture.exe user32.lib
 * Or with MinGW: gcc -O2 windows-context-capture.c -o windows-context-capture.exe -luser32
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

static void json_escape(const char *src, char *dst, size_t dst_size) {
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 1 < dst_size; i++) {
        char c = src[i];
        if ((c == '\\' || c == '"') && j + 2 < dst_size) {
            dst[j++] = '\\';
            dst[j++] = c;
        } else if (c == '\n' && j + 2 < dst_size) {
            dst[j++] = '\\'; dst[j++] = 'n';
        } else if (c == '\r' && j + 2 < dst_size) {
            dst[j++] = '\\'; dst[j++] = 'r';
        } else if (c == '\t' && j + 2 < dst_size) {
            dst[j++] = '\\'; dst[j++] = 't';
        } else if (c != '\\' && c != '"' && c != '\n' && c != '\r' && c != '\t') {
            dst[j++] = c;
        }
    }
    dst[j] = '\0';
}

int main(void) {
    HWND hwnd = GetForegroundWindow();
    if (!hwnd) {
        fprintf(stderr, "No foreground window\n");
        return 1;
    }

    /* Window title: UTF-16 -> UTF-8 */
    WCHAR titleW[1024];
    int titleLen = GetWindowTextW(hwnd, titleW, 1024);
    char titleUtf8[4096] = {0};
    if (titleLen > 0) {
        WideCharToMultiByte(CP_UTF8, 0, titleW, titleLen, titleUtf8,
                            sizeof(titleUtf8) - 1, NULL, NULL);
    }

    /* Process executable name */
    char exeName[MAX_PATH] = {0};
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid) {
        HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (hProcess) {
            char exePath[MAX_PATH];
            DWORD pathLen = MAX_PATH;
            if (QueryFullProcessImageNameA(hProcess, 0, exePath, &pathLen) && pathLen > 0) {
                const char *base = strrchr(exePath, '\\');
                base = base ? base + 1 : exePath;
                strncpy(exeName, base, MAX_PATH - 1);
            }
            CloseHandle(hProcess);
        }
    }

    char escapedTitle[8192];
    char escapedExe[MAX_PATH * 2];
    json_escape(titleUtf8, escapedTitle, sizeof(escapedTitle));
    json_escape(exeName, escapedExe, sizeof(escapedExe));

    printf("{\"appName\":\"%s\",\"windowTitle\":\"%s\"}\n", escapedExe, escapedTitle);
    fflush(stdout);
    return 0;
}
