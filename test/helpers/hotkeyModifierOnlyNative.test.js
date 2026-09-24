const test = require("node:test");
const assert = require("node:assert/strict");

// A modifier-only chord has no regular key, so Electron cannot build an
// accelerator for it. Registering one always fails; the low-level listener is
// what actually watches these on Windows and Linux. Any register() call reaching
// this stub for such a hotkey is the bug this guards against.
const registered = new Map();
require.cache[require.resolve("electron")] = {
  exports: {
    globalShortcut: {
      register(accelerator, callback) {
        registered.set(accelerator, callback);
        return true;
      },
      unregister(accelerator) {
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
      unregisterAll() {
        registered.clear();
      },
    },
    BrowserWindow: class {},
  },
};

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

const noop = () => {};
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const setPlatform = (value) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

test.beforeEach(() => registered.clear());
test.after(() => Object.defineProperty(process, "platform", originalPlatform));

for (const platform of ["win32", "linux"]) {
  test(`modifier-only chords skip globalShortcut on ${platform} and go to the native listener`, async () => {
    setPlatform(platform);
    const mgr = new HotkeyManager();

    const result = await mgr.registerSlot("dictation", "Control+Super", noop);

    assert.equal(result.success, true);
    assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["Control+Super"]);
    assert.equal(registered.size, 0, "globalShortcut must not be used for a modifier-only chord");
    assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["Control+Super"]);
  });
}

test("a right-side single modifier also reaches the native listener on linux", async () => {
  setPlatform("linux");
  const mgr = new HotkeyManager();

  const result = await mgr.registerSlot("dictation", "RightControl", noop);

  assert.equal(result.success, true);
  assert.equal(registered.size, 0);
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["RightControl"]);
});

// The listener backing those hotkeys needs its binary and read access to
// /dev/input. When it cannot run, registration must fail like a refused
// globalShortcut.register so the startup fallback, the Settings error and the
// slot rollback all still happen. The managers stay uninitialized on purpose: a
// saved hotkey registers from .env inside initializeHotkey, before isInitialized
// is set, and must be refused there too.
const denyProbe = (reason) => () => ({ available: false, reason });

for (const hotkey of ["Control+Super", "Control+Alt", "RightControl"]) {
  test(`linux refuses "${hotkey}" when the listener has no input access`, async () => {
    setPlatform("linux");
    const mgr = new HotkeyManager();
    mgr.nativeListenerProbe = denyProbe("input_access_denied");

    const result = await mgr.registerSlot("dictation", hotkey, noop);

    assert.equal(result.success, false);
    assert.equal(registered.size, 0, "a refused hotkey must not fall back to globalShortcut");
    assert.match(result.error, /usermod/, "the error must tell the user how to fix it");
    for (const suggestion of result.suggestions) {
      assert.equal(
        HotkeyManager.isModifierOnlyHotkey(suggestion) ||
          HotkeyManager.isRightSideModifier(suggestion),
        false,
        `"${suggestion}" needs the same listener`
      );
    }
  });
}

test("a refused listener hotkey leaves the slot on its previous binding", async () => {
  setPlatform("linux");
  const mgr = new HotkeyManager();

  await mgr.registerSlot("dictation", "F8", noop);
  mgr.nativeListenerProbe = denyProbe("input_access_denied");
  const result = await mgr.registerSlot("dictation", "Control+Super", noop);

  assert.equal(result.success, false);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["F8"]);
  assert.equal(registered.has("F8"), true, "the previous accelerator must stay registered");
});

test("a missing listener binary reports the push-to-talk unavailable message", async () => {
  setPlatform("linux");
  const mgr = new HotkeyManager();
  mgr.nativeListenerProbe = denyProbe("binary_missing");

  const result = await mgr.registerSlot("dictation", "Control+Super", noop);

  assert.equal(result.success, false);
  // setupShortcuts appends "Try: <suggestions>" to whatever the failure carried.
  assert.equal(result.error.startsWith("Push-to-Talk native listener not available"), true);
});

test("a failing probe is ignored off linux", async () => {
  setPlatform("win32");
  const mgr = new HotkeyManager();
  mgr.nativeListenerProbe = denyProbe("input_access_denied");

  const result = await mgr.registerSlot("dictation", "Control+Super", noop);

  assert.equal(result.success, true);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["Control+Super"]);
});

// GNOME, KDE and Hyprland register through their own shortcut systems, which
// need a regular key and never start the listener in Tap. A lone right modifier
// must be refused with a reason instead of failing there as a format error.
for (const backend of ["useGnome", "useKDE", "useHyprland"]) {
  test(`a right-side single modifier is refused with a reason when ${backend} is active`, async () => {
    setPlatform("linux");
    const mgr = new HotkeyManager();
    mgr[backend] = true;

    const slotResult = await mgr.registerSlot("voiceAgent", "RightControl", noop);
    const updateResult = await mgr.updateHotkey("RightControl", noop);

    assert.equal(slotResult.success, false);
    assert.match(slotResult.error, /regular key/);
    assert.equal(updateResult.success, false);
    assert.match(updateResult.message, /regular key/);
    assert.equal(registered.size, 0);
  });
}
