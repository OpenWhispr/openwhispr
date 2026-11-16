const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { runLinuxFastPasteFixture } = require("../lib/linuxFastPasteFixture");

// The modifier gate must read the key state the X server reports on an X11
// session, so strip anything that would make the helper treat this as Wayland.
const X11_SESSION_ENV = { ...process.env, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: undefined };
const WAYLAND_SESSION_ENV = { ...process.env, XDG_SESSION_TYPE: "wayland" };

function uinputUnavailable() {
  try {
    fs.accessSync("/dev/uinput", fs.constants.W_OK);
    return false;
  } catch {
    return "/dev/uinput is not writable";
  }
}

test(
  "native modifier gate waits for a held modifier, ignores locked ones, and reports an unreadable XKB state as unknown",
  { skip: process.platform !== "linux" && "Linux only", timeout: 30_000 },
  async (t) => {
    const result = await runLinuxFastPasteFixture(t, "linuxModifierGate", {
      env: X11_SESSION_ENV,
      sharedLibraries: ["xkbUnavailable"],
    });
    if (!result) return;
    assert.match(result.stdout, /modifier gate native checks passed/);
  }
);

// The Wayland side reads /dev/input, which is what push-to-talk users run on.
test(
  "native evdev modifier gate sees a held key on a keyboard and ignores ydotoold's virtual one",
  {
    skip: (process.platform !== "linux" && "Linux only") || uinputUnavailable(),
    timeout: 30_000,
  },
  async (t) => {
    const result = await runLinuxFastPasteFixture(t, "linuxModifierGateEvdev", {
      env: WAYLAND_SESSION_ENV,
    });
    if (!result) return;
    assert.match(result.stdout, /evdev modifier gate native checks passed/);
  }
);
