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

// macOS watches modifier-only chords with the Globe listener, which names a
// chord by its modifiers in a fixed order whatever the hotkey's spelling.
test("modifier-only chords skip globalShortcut on darwin and go to the Globe listener", async () => {
  setPlatform("darwin");
  const mgr = new HotkeyManager();

  const result = await mgr.registerSlot("dictation", "Command+Alt", noop);

  assert.equal(result.success, true);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["Command+Alt"]);
  assert.equal(registered.size, 0, "globalShortcut must not be used for a modifier-only chord");
  assert.deepEqual(mgr.getMacNativeListenerConfig(["dictation"]).modifierChords, [
    "option+command",
  ]);
  assert.equal(mgr.slotHasMacModifierChord("dictation", "option+command"), true);
  assert.equal(mgr.slotHasMacModifierChord("dictation", "control+option"), false);
  assert.equal(mgr.supportsPushToTalk("Command+Alt"), true, "the listener reports release");
});

test("a modifier chord spelled differently is the same chord on darwin", async () => {
  setPlatform("darwin");
  const mgr = new HotkeyManager();

  await mgr.registerSlot("dictation", "Alt+Command", noop);
  const result = await mgr.registerSlot("voiceAgent", "Cmd+Option", noop);

  assert.equal(result.success, false, "the chord already belongs to dictation");
  assert.equal(result.reason, "slot_conflict");
});

test("Command+Super is one key on darwin, not a chord", async () => {
  setPlatform("darwin");
  const mgr = new HotkeyManager();

  const result = await mgr.registerSlot("dictation", "Command+Super", noop);

  assert.equal(result.success, false);
  assert.equal(registered.size, 0);
});

test("toMacModifierChord orders modifiers and resolves aliases", () => {
  const { toMacModifierChord } = HotkeyManager;

  assert.equal(toMacModifierChord("Command+Alt"), "option+command");
  assert.equal(toMacModifierChord("Option+Cmd"), "option+command");
  assert.equal(toMacModifierChord("Shift+Control"), "control+shift");
  assert.equal(toMacModifierChord("CommandOrControl+Alt"), "option+command");
  assert.equal(toMacModifierChord("Command+Super"), null);
  assert.equal(toMacModifierChord("Control+Alt+Space"), null);
  assert.equal(toMacModifierChord("RightOption"), null);
  assert.equal(toMacModifierChord("GLOBE"), null);
});

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
  assert.equal(result.error.startsWith("OpenWhispr's key listener isn't available."), true);
});

// Windows answers through its own probe (windows-key-listener.exe); macOS watches
// right-side modifiers with the Globe listener and has none.
test("a failing probe is ignored on macOS", async () => {
  setPlatform("darwin");
  const mgr = new HotkeyManager();
  mgr.nativeListenerProbe = denyProbe("binary_missing");

  const result = await mgr.registerSlot("dictation", "RightOption", noop);

  assert.equal(result.success, true);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["RightOption"]);
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
