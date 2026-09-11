#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>

// Exit 2 means unsupported before any mutation. Exit 3 means uncertain: do not retry.
int main(void) {
    _setmode(_fileno(stdin), _O_BINARY);
    char *input = (char*)calloc(1048577, 1);
    if (!input) return 2;
    size_t size = fread(input, 1, 1048577, stdin);
    if (!size || size > 1048576) { free(input); return 2; }
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, (int)size, NULL, 0);
    if (!count) { free(input); return 2; }
    wchar_t *text = (wchar_t*)calloc(count + 1, sizeof(wchar_t));
    if (!text) { free(input); return 2; }
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, (int)size, text, count);
    free(input);
    HWND foreground = GetForegroundWindow();
    DWORD thread = GetWindowThreadProcessId(foreground, NULL);
    GUITHREADINFO info = {0}; info.cbSize = sizeof(info);
    wchar_t className[128] = {0};
    if (!GetGUIThreadInfo(thread, &info) || !info.hwndFocus ||
        !GetClassNameW(info.hwndFocus, className, 128) || _wcsicmp(className, L"Edit") != 0 ||
        !IsWindowEnabled(info.hwndFocus) ||
        (GetWindowLongPtrW(info.hwndFocus, GWL_STYLE) & (ES_READONLY | ES_PASSWORD)) ||
        GetForegroundWindow() != foreground) { free(text); return 2; }
    DWORD_PTR result;
    LRESULT sent = SendMessageTimeoutW(info.hwndFocus, EM_REPLACESEL, TRUE, (LPARAM)text,
        SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &result);
    free(text);
    return sent ? 0 : 3;
}
