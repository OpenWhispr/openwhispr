#include <assert.h>

#define main WindowsKeyListenerMain
#include "../../resources/windows-key-listener.c"
#undef main

int main(void) {
    assert(ParseCompoundHotkey("Delete") == VK_DELETE);
    assert(ParseCompoundHotkey("Del") == VK_DELETE);
    assert(ParseCompoundHotkey("Alt+Delete") == VK_DELETE);
    assert(g_requireAlt);

    assert(ParseCompoundHotkey("Backspace") == VK_BACK);
    assert(ParseCompoundHotkey("Left") == VK_LEFT);
    assert(ParseCompoundHotkey("Up") == VK_UP);
    assert(ParseCompoundHotkey("Right") == VK_RIGHT);
    assert(ParseCompoundHotkey("Down") == VK_DOWN);
    assert(ParseCompoundHotkey("PrintScreen") == VK_SNAPSHOT);
    assert(ParseCompoundHotkey("Control+PrintScreen") == VK_SNAPSHOT);
    assert(g_requireCtrl);
    return 0;
}
