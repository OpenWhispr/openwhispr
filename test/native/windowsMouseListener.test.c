// Exercise the hook callback without installing a global hook or moving a mouse.
#define main listener_main
#include "../../resources/windows-key-listener.c"
#undef main
#include <assert.h>

int main(void) {
    assert(ParseKeyCode("MouseButton4") == VK_XBUTTON1);
    assert(ParseKeyCode("MouseButton5") == VK_XBUTTON2);
    assert(ParseKeyCode("F8") == VK_F8);
    DWORD downMessages[] = {WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_MBUTTONDOWN};
    DWORD upMessages[] = {WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP};
    DWORD keys[] = {VK_LBUTTON, VK_RBUTTON, VK_MBUTTON};
    for (int i = 0; i < 3; i++) {
        MSLLHOOKSTRUCT event = {0};
        char name[16];
        sprintf(name, "MouseButton%d", i + 1);
        assert(ParseKeyCode(name) == keys[i]);
        g_targetVk = keys[i]; g_isKeyDown = FALSE;
        assert(LowLevelMouseProc(HC_ACTION, downMessages[i], (LPARAM)&event) == 1);
        assert(g_isKeyDown);
        assert(LowLevelMouseProc(HC_ACTION, downMessages[i], (LPARAM)&event) == 1);
        assert(LowLevelMouseProc(HC_ACTION, upMessages[i], (LPARAM)&event) == 1);
        assert(!g_isKeyDown);
        assert(LowLevelMouseProc(HC_ACTION, upMessages[i], (LPARAM)&event) == 1);
    }
    for (int button = XBUTTON1; button <= XBUTTON2; button++) {
        MSLLHOOKSTRUCT event = {0};
        event.mouseData = ((DWORD)button) << 16;
        g_targetVk = button == XBUTTON1 ? VK_XBUTTON1 : VK_XBUTTON2;
        g_isKeyDown = FALSE;
        event.flags = LLMHF_INJECTED;
        LowLevelMouseProc(HC_ACTION, WM_XBUTTONDOWN, (LPARAM)&event);
        assert(!g_isKeyDown);
        event.flags = 0;
        event.mouseData = ((DWORD)(button == XBUTTON1 ? XBUTTON2 : XBUTTON1)) << 16;
        LowLevelMouseProc(HC_ACTION, WM_XBUTTONDOWN, (LPARAM)&event);
        assert(!g_isKeyDown);
        event.mouseData = ((DWORD)button) << 16;
        assert(LowLevelMouseProc(HC_ACTION, WM_XBUTTONDOWN, (LPARAM)&event) == 1);
        assert(g_isKeyDown);
        assert(LowLevelMouseProc(HC_ACTION, WM_XBUTTONDOWN, (LPARAM)&event) == 1);
        assert(LowLevelMouseProc(HC_ACTION, WM_XBUTTONUP, (LPARAM)&event) == 1);
        assert(!g_isKeyDown);
        assert(LowLevelMouseProc(HC_ACTION, WM_XBUTTONUP, (LPARAM)&event) == 1);
    }
    return 0;
}
