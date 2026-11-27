#define main WindowsKeyListenerMain
#include "../../resources/windows-key-listener.c"
#undef main

// Not assert(): a build with NDEBUG would turn every check into a no-op.
static int failures = 0;
#define EXPECT(condition)                                                     \
    do {                                                                      \
        if (!(condition)) {                                                   \
            fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #condition);      \
            failures++;                                                       \
        }                                                                     \
    } while (0)

int main(void) {
    EXPECT(ParseCompoundHotkey("Delete") == VK_DELETE);
    EXPECT(ParseCompoundHotkey("Del") == VK_DELETE);
    EXPECT(ParseCompoundHotkey("Alt+Delete") == VK_DELETE);
    EXPECT(g_requireAlt);

    EXPECT(ParseCompoundHotkey("Backspace") == VK_BACK);
    EXPECT(ParseCompoundHotkey("Left") == VK_LEFT);
    EXPECT(ParseCompoundHotkey("Up") == VK_UP);
    EXPECT(ParseCompoundHotkey("Right") == VK_RIGHT);
    EXPECT(ParseCompoundHotkey("Down") == VK_DOWN);
    EXPECT(ParseCompoundHotkey("PrintScreen") == VK_SNAPSHOT);
    EXPECT(ParseCompoundHotkey("Control+PrintScreen") == VK_SNAPSHOT);
    EXPECT(g_requireCtrl);
    return failures == 0 ? 0 : 1;
}
