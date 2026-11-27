const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function runNativeHarness(t, source) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-exact-modifiers-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const harness = path.join(scratch, "match.c");
  const binary = path.join(scratch, "match");
  fs.writeFileSync(harness, source);
  const compiled = spawnSync("cc", ["-std=c99", harness, "-o", binary], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000, cwd: scratch });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

function sourceBetween(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start, first);
  return source.slice(start, end);
}

test(
  "combined-mode bindings agree with the native Windows and Linux parsers",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const HotkeyManager = require("../../src/helpers/hotkeyManager");
    const platformProperty = Object.getOwnPropertyDescriptor(process, "platform");
    t.after(() => Object.defineProperty(process, "platform", platformProperty));
    // A rejected shortcut can still parse on an older Hold path. Check what each
    // parser actually sees so partial matches cannot silently become eligible.
    const bindings = [
      ["Ctrl+Shift+Space", "VK_SPACE", "KEY_SPACE", 5],
      ["Option+Q", "'Q'", "KEY_Q", 2],
      ["CommandOrControl+F24", "VK_F24", "KEY_F24", 1],
      ["Super+Backquote", "VK_OEM_3", "KEY_GRAVE", 8],
      ["Control+\\", "VK_OEM_5", "KEY_BACKSLASH", 1],
      ["Control+,", "VK_OEM_COMMA", "KEY_COMMA", 1],
      ["Ctrl+Minus", "VK_OEM_MINUS", "0", 1],
      ["Control+Super", "0", "0", 9, false],
      ["Control+A+Space", "VK_SPACE", "KEY_SPACE", 1, false],
      ["Control++Space", "VK_SPACE", "KEY_SPACE", 1, false],
      ["Control+0x41", "'A'", "0", 1, false],
      ["Control+K", "0", "0", 1, false],
    ];

    for (const [platform, listener] of [
      ["win32", "windows"],
      ["linux", "linux"],
    ]) {
      Object.defineProperty(process, "platform", { ...platformProperty, value: platform });
      const manager = new HotkeyManager();
      manager.nativeListenerSupportsExactModifiers = () => true;
      const source = fs.readFileSync(
        path.join(__dirname, `../../resources/${listener}-key-listener.c`),
        "utf8"
      );
      const windows = platform === "win32";
      const parser = windows
        ? sourceBetween(source, "DWORD ParseKeyCode(", "LRESULT CALLBACK LowLevelKeyboardProc(") +
          sourceBetween(source, "DWORD ParseCompoundHotkey(", "int main(")
        : sourceBetween(source, "static int map_key_name(", "static int is_keyboard_device(");
      // The parsers only need symbolic key constants. Give each a unique value
      // outside ASCII so the same C code can run without either platform SDK.
      const keys = [...new Set(parser.match(/\b(?:VK|KEY)_[A-Z0-9_]+\b/g))];
      const constants = keys.map((key, index) => `${key} = ${index + 256}`).join(", ");
      const declarations = windows
        ? "typedef unsigned DWORD; static int g_requireCtrl, g_requireAlt, g_requireShift, g_requireWin, g_useModifiersOnly;"
        : "static int require_ctrl, require_alt, require_shift, require_super, use_modifiers_only, target_key;";
      const parsedModifiers = windows
        ? "g_requireCtrl | g_requireAlt << 1 | g_requireShift << 2 | g_requireWin << 3"
        : "require_ctrl | require_alt << 1 | require_shift << 2 | require_super << 3";
      const parse = windows
        ? "unsigned target = ParseCompoundHotkey(binding);"
        : "parse_hotkey(binding); int target = target_key;";
      const cases = bindings.map(
        ([binding, winKey, linuxKey, modifiers]) =>
          `check(${JSON.stringify(binding)}, ${windows ? winKey : linuxKey}, ${modifiers});`
      );

      runNativeHarness(
        t,
        `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#define FALSE 0
#define TRUE 1
#define _stricmp strcasecmp
enum { ${constants} };
${declarations}
${parser}

static void check(const char *binding, int expectedKey, int expectedModifiers) {
    ${parse}
    if (target != expectedKey || (${parsedModifiers}) != expectedModifiers) {
        fprintf(stderr, "Unexpected native parse for %s\\n", binding);
        exit(1);
    }
}
int main(void) {
    ${cases.join("\n")}
}
`
      );

      for (const [binding, winKey, linuxKey, , valid = true] of bindings) {
        const eligible = valid && (windows ? winKey : linuxKey) !== "0";
        assert.equal(
          manager.getDictationDoublePressUnavailableReason(binding) === null,
          eligible,
          `${platform} ${binding}`
        );
      }
    }
  }
);

function runWindowsEvents(t, events) {
  const source = fs.readFileSync(
    path.join(__dirname, "../../resources/windows-key-listener.c"),
    "utf8"
  );
  return runNativeHarness(
    t,
    `
#include <assert.h>
#include <stdio.h>
#include <stdint.h>
#define TRUE 1
#define FALSE 0
#define CALLBACK
typedef int BOOL;
typedef void *HHOOK;
typedef unsigned DWORD, WPARAM;
typedef intptr_t LRESULT, LPARAM;
typedef struct { DWORD vkCode, scanCode; } KBDLLHOOKSTRUCT;
enum { HC_ACTION, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP };
enum { VK_CONTROL, VK_LCONTROL, VK_RCONTROL, VK_MENU, VK_LMENU, VK_RMENU,
       VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_LWIN, VK_RWIN };
static BOOL keys[256];

static int GetAsyncKeyState(DWORD key) {
    if (key == VK_MENU) return (keys[VK_LMENU] || keys[VK_RMENU]) ? 0x8000 : 0;
    if (key == VK_SHIFT) return (keys[VK_LSHIFT] || keys[VK_RSHIFT]) ? 0x8000 : 0;
    return keys[key] ? 0x8000 : 0;
}

static LRESULT CallNextHookEx(HHOOK hook, int code, WPARAM event, LPARAM key) {
    return 0;
}

${sourceBetween(source, "static HHOOK g_hook", "// Map key name to virtual key code")}
${sourceBetween(source, "LRESULT CALLBACK LowLevelKeyboardProc(", "BOOL WINAPI ConsoleHandler(")}

static void send_key(DWORD key, DWORD scan_code, BOOL pressed) {
    KBDLLHOOKSTRUCT event = { key, scan_code };
    LowLevelKeyboardProc(HC_ACTION, pressed ? WM_KEYDOWN : WM_KEYUP, (LPARAM)&event);
    keys[key] = pressed;
}

static void tap_q(void) {
    send_key('Q', 0, TRUE);
    send_key('Q', 0, FALSE);
}

int main(void) {
    g_targetVk = 'Q';
    g_requireAlt = TRUE;
    ${events}
}
`
  )
    .trim()
    .split("\n");
}

test(
  "Windows matches exact modifier sets only for combined-mode input",
  { skip: process.platform === "win32" },
  (t) => {
    runWindowsEvents(
      t,
      `
g_requireAlt = FALSE;
g_requireCtrl = g_ctrlDown = g_shiftDown = TRUE;
assert(AreRequiredModifiersPressed());
g_exactModifiers = TRUE;
assert(!AreRequiredModifiersPressed());
g_shiftDown = FALSE;
assert(AreRequiredModifiersPressed());
g_ctrlDown = FALSE;
assert(!AreRequiredModifiersPressed());
g_requireCtrl = FALSE;
assert(AreRequiredModifiersPressed());
g_leftWinDown = TRUE;
assert(!AreRequiredModifiersPressed());
`
    );
  }
);

test(
  "Windows combined mode rejects AltGr typing and still accepts genuine Alt taps",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const events = runWindowsEvents(
      t,
      `
g_exactModifiers = TRUE;
send_key(VK_LCONTROL, 0x200, TRUE);
send_key(VK_RMENU, 0, TRUE);
tap_q();
tap_q();
send_key(VK_LCONTROL, 0x200, FALSE);
tap_q();
send_key(VK_RMENU, 0, FALSE);

send_key(VK_RMENU, 0, TRUE);
tap_q();
tap_q();
send_key(VK_RMENU, 0, FALSE);
`
    );
    assert.deepEqual(events, [
      "KEY_INTERRUPTED",
      "KEY_INTERRUPTED",
      "KEY_INTERRUPTED",
      "KEY_DOWN",
      "KEY_UP",
      "KEY_DOWN",
      "KEY_UP",
    ]);
  }
);

test(
  "Windows combined mode interrupts an active tap as AltGr begins",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const events = runWindowsEvents(
      t,
      `
g_exactModifiers = TRUE;
send_key(VK_LMENU, 0, TRUE);
send_key('Q', 0, TRUE);
send_key(VK_LCONTROL, 0x200, TRUE);
send_key('Q', 0, FALSE);
send_key(VK_RMENU, 0, TRUE);
send_key(VK_RMENU, 0, FALSE);
send_key(VK_LCONTROL, 0x200, FALSE);
send_key(VK_LMENU, 0, FALSE);
`
    );
    assert.deepEqual(events, ["KEY_DOWN", "KEY_INTERRUPTED"]);
  }
);

test(
  "Windows combined mode recovers after missing AltGr releases",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const events = runWindowsEvents(
      t,
      `
g_exactModifiers = TRUE;
send_key(VK_LCONTROL, 0x200, TRUE);
send_key(VK_RMENU, 0, TRUE);
tap_q();
keys[VK_LCONTROL] = keys[VK_RMENU] = FALSE;

send_key(VK_LMENU, 0, TRUE);
tap_q();
send_key(VK_LMENU, 0, FALSE);
`
    );
    assert.deepEqual(events, ["KEY_INTERRUPTED", "KEY_DOWN", "KEY_UP"]);
  }
);

test(
  "Windows legacy Hold keeps AltGr normalization for Alt and Ctrl+Alt",
  {
    skip: process.platform === "win32",
  },
  (t) => {
    const events = runWindowsEvents(
      t,
      `
send_key(VK_LCONTROL, 0x200, TRUE);
send_key(VK_RMENU, 0, TRUE);
tap_q();

g_requireCtrl = TRUE;
tap_q();
send_key(VK_RMENU, 0, FALSE);
send_key(VK_LCONTROL, 0x200, FALSE);
send_key(VK_LCONTROL, 0, TRUE);
send_key(VK_RMENU, 0, TRUE);
tap_q();
`
    );
    assert.deepEqual(events, ["KEY_DOWN", "KEY_UP", "KEY_DOWN", "KEY_UP"]);
  }
);

function runEvdevEvents(t, events) {
  const source = fs.readFileSync(
    path.join(__dirname, "../../resources/linux-key-listener.c"),
    "utf8"
  );
  const output = runNativeHarness(
    t,
    `
#include <assert.h>
#include <stdio.h>
#include <string.h>
enum { KEY_LEFTCTRL, KEY_RIGHTCTRL, KEY_LEFTALT, KEY_RIGHTALT, KEY_LEFTSHIFT,
       KEY_RIGHTSHIFT, KEY_LEFTMETA, KEY_RIGHTMETA, KEY_SPACE, KEY_MAX = KEY_SPACE };
enum { EV_SYN, EV_KEY };
enum { SYN_REPORT, SYN_DROPPED = 3 };
struct input_event { int type, code, value; };
#define KEY_BITS_SIZE (KEY_MAX / 8 + 1)
#define MAX_DEVICES 2
#define EVIOCGKEY(size) (size)
static int exact_modifiers = 1, require_ctrl = 1, require_alt, require_shift, require_super;
static int target_key = KEY_SPACE, hotkey_active, use_modifiers_only;
static unsigned char kernel_keys[2][KEY_BITS_SIZE];

static int ioctl(int fd, int size, unsigned char *keys) {
    memcpy(keys, kernel_keys[fd], size);
    return size;
}

${sourceBetween(source, "struct keyboard_device {", "static int permission_denied_count")}
${sourceBetween(source, "static void read_device_keys(", "static int map_key_name(")}
${sourceBetween(source, "static int all_devices_synchronized(", "int main(")}

static void send_event(int fd, int type, int code, int value) {
    struct input_event event = { .type = type, .code = code, .value = value };
    handle_device_event(&devices[fd], &event);
}

int main(void) {
    device_count = 2;
    devices[0].fd = 0;
    devices[1].fd = 1;
    ${events}
}
`
  );
  return output.trim().split("\n");
}

test(
  "evdev matches exact modifier sets only for combined-mode input",
  { skip: process.platform === "win32" },
  (t) => {
    runEvdevEvents(
      t,
      `
exact_modifiers = 0;
set_key(&devices[0], KEY_LEFTCTRL, 1);
set_key(&devices[0], KEY_LEFTSHIFT, 1);
assert(modifiers_satisfied());
exact_modifiers = 1;
assert(!modifiers_satisfied());
set_key(&devices[0], KEY_LEFTSHIFT, 0);
assert(modifiers_satisfied());
set_key(&devices[0], KEY_LEFTCTRL, 0);
assert(!modifiers_satisfied());
require_ctrl = 0;
assert(modifiers_satisfied());
set_key(&devices[0], KEY_LEFTMETA, 1);
assert(!modifiers_satisfied());
`
    );
  }
);

test(
  "evdev interrupts an inexact chord without emitting a tap release",
  { skip: process.platform === "win32" },
  (t) => {
    const events = runEvdevEvents(
      t,
      `
send_event(0, EV_KEY, KEY_LEFTCTRL, 1);
send_event(0, EV_KEY, KEY_LEFTSHIFT, 1);
send_event(0, EV_KEY, KEY_SPACE, 1);
send_event(0, EV_KEY, KEY_SPACE, 0);
send_event(0, EV_KEY, KEY_LEFTSHIFT, 0);
send_event(0, EV_KEY, KEY_SPACE, 1);
send_event(0, EV_KEY, KEY_LEFTSHIFT, 1);
send_event(0, EV_KEY, KEY_SPACE, 2);
send_event(0, EV_KEY, KEY_SPACE, 0);
send_event(0, EV_KEY, KEY_LEFTSHIFT, 0);
send_event(0, EV_KEY, KEY_SPACE, 1);
send_event(0, EV_KEY, KEY_SPACE, 0);
`
    );
    assert.deepEqual(events, [
      "KEY_INTERRUPTED",
      "KEY_DOWN",
      "KEY_INTERRUPTED",
      "KEY_DOWN",
      "KEY_UP",
    ]);
  }
);

test(
  "evdev still sees a modifier held on another keyboard after its matching key is released",
  { skip: process.platform === "win32" },
  (t) => {
    const events = runEvdevEvents(
      t,
      `
send_event(0, EV_KEY, KEY_LEFTSHIFT, 1);
send_event(1, EV_KEY, KEY_LEFTSHIFT, 1);
send_event(1, EV_KEY, KEY_LEFTSHIFT, 0);
send_event(1, EV_KEY, KEY_LEFTCTRL, 1);
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
send_event(0, EV_KEY, KEY_LEFTSHIFT, 0);
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
`
    );
    assert.deepEqual(events, ["KEY_INTERRUPTED", "KEY_INTERRUPTED", "KEY_DOWN", "KEY_UP"]);
  }
);

test(
  "evdev interrupts a tap sequence on input loss and resumes with the resynchronized modifier state",
  { skip: process.platform === "win32" },
  (t) => {
    const events = runEvdevEvents(
      t,
      `
send_event(1, EV_KEY, KEY_LEFTCTRL, 1);
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
send_event(0, EV_SYN, SYN_DROPPED, 0);
puts("input lost");
send_event(0, EV_KEY, KEY_SPACE, 1);
send_event(0, EV_KEY, KEY_SPACE, 0);
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
kernel_keys[0][KEY_LEFTSHIFT / 8] |= 1 << (KEY_LEFTSHIFT % 8);
send_event(0, EV_SYN, SYN_REPORT, 0);
puts("input resynchronized");
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
send_event(0, EV_KEY, KEY_LEFTSHIFT, 0);
send_event(1, EV_KEY, KEY_SPACE, 1);
send_event(1, EV_KEY, KEY_SPACE, 0);
`
    );
    assert.deepEqual(events, [
      "KEY_DOWN",
      "KEY_UP",
      "KEY_INTERRUPTED",
      "input lost",
      "input resynchronized",
      "KEY_INTERRUPTED",
      "KEY_DOWN",
      "KEY_UP",
    ]);
  }
);
