const test = require("node:test");
const assert = require("node:assert/strict");

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

// Build a manager with an explicit set of slot hotkeys, independent of the
// platform default so the assertions are deterministic everywhere. A slot value
// may be a single hotkey string or an array (multi-hotkey, issue #936).
const makeManager = (slots) => {
  const mgr = new HotkeyManager();
  mgr.slots.clear();
  for (const [name, value] of Object.entries(slots)) {
    const hotkeys = Array.isArray(value) ? value : value ? [value] : [];
    mgr.slots.set(name, { hotkeys, callback: null, accelerators: [] });
  }
  return mgr;
};

test("tap mode watches modifier-only hotkeys for every slot", () => {
  const mgr = makeManager({
    dictation: "Control+Super",
    voiceAgent: "Control+Alt",
    agent: "Alt+Super",
  });
  assert.deepEqual(mgr.getNativeListenerKeys("tap").sort(), [
    "Alt+Super",
    "Control+Alt",
    "Control+Super",
  ]);
});

test("regular key hotkeys are left to globalShortcut in tap mode", () => {
  const mgr = makeManager({ dictation: "F8", voiceAgent: "Control+Shift+A" });
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), []);
});

test("push mode watches the dictation key even when it is a regular key", () => {
  const mgr = makeManager({ dictation: "F8", voiceAgent: "Control+Shift+A" });
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["F8"]);
});

test("push mode does not push-enable non-dictation slots", () => {
  const mgr = makeManager({ dictation: "Control+Super", agent: "F9" });
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["Control+Super"]);
});

test("right-side modifiers use the native listener; globe/empty slots do not", () => {
  const mgr = makeManager({
    dictation: "GLOBE",
    voiceAgent: "RightControl",
    agent: "",
  });
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["RightControl"]);
});

test("a multi-hotkey slot watches each native hotkey but leaves regular keys to globalShortcut", () => {
  // dictation bound to both GLOBE (native, macOS) and Control+Shift+R (regular).
  const mgr = makeManager({ dictation: ["GLOBE", "Control+Shift+R", "RightControl"] });
  assert.deepEqual(mgr.getNativeListenerKeys("tap"), ["RightControl"]);
});

test("push mode watches every dictation hotkey, including regular keys", () => {
  const mgr = makeManager({ dictation: ["F8", "Control+Shift+R"] });
  assert.deepEqual(mgr.getNativeListenerKeys("push").sort(), ["Control+Shift+R", "F8"]);
});

test("a voiceAgent slot set to Hold watches its regular-key hotkeys", () => {
  const mgr = makeManager({ dictation: "F8", voiceAgent: "F9" });
  assert.deepEqual(mgr.getNativeListenerKeys("tap", { voiceAgent: "push" }), ["F9"]);
});

test("a translation slot set to Hold watches every translation hotkey", () => {
  const mgr = makeManager({ translation: ["F7", "Control+Shift+T"] });
  assert.deepEqual(mgr.getNativeListenerKeys("tap", { translation: "push" }).sort(), [
    "Control+Shift+T",
    "F7",
  ]);
});

test("meeting and unknown slots are never push-enabled by slot modes", () => {
  const mgr = makeManager({ meeting: "F6", cancel: "F5" });
  assert.deepEqual(mgr.getNativeListenerKeys("tap", { meeting: "push", cancel: "push" }), []);
});

test("membership and lookup helpers work across multi-hotkey slots", () => {
  const mgr = makeManager({
    dictation: ["GLOBE", "Control+Shift+R"],
    meeting: "Control+Alt",
  });
  assert.equal(mgr.slotHasHotkey("dictation", "Control+Shift+R"), true);
  assert.equal(mgr.slotHasHotkey("dictation", "F12"), false);
  assert.equal(mgr.findSlotByHotkey("Control+Shift+R"), "dictation");
  assert.equal(mgr.findSlotByHotkey("Control+Alt"), "meeting");
  assert.equal(mgr.findSlotByHotkey("Nope"), null);
  assert.deepEqual(mgr.getSlotHotkeys("dictation"), ["GLOBE", "Control+Shift+R"]);
  assert.equal(mgr.getSlotHotkey("dictation"), "GLOBE");
});

// The macOS Globe listener config drives both mouse-button suppression and
// whether macOS's own standalone Globe action has to stand down.
const MAC_SLOTS = ["dictation", "voiceAgent", "translation"];

test("Globe in any supported slot asks for system Globe suppression", () => {
  for (const slot of MAC_SLOTS) {
    const mgr = makeManager({ [slot]: "GLOBE" });
    assert.equal(
      mgr.getMacNativeListenerConfig(MAC_SLOTS).suppressGlobeAction,
      true,
      `slot "${slot}" should request suppression`
    );
  }
});

test("Fn is treated as Globe, including as a secondary hotkey", () => {
  const mgr = makeManager({ voiceAgent: ["Control+Shift+R", "Fn"] });
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS), {
    mouseButtons: [],
    suppressGlobeAction: true,
    watchKeys: [],
  });
});

test("mouse buttons are collected across slots and de-duplicated", () => {
  const mgr = makeManager({
    dictation: ["MouseButton4", "F8"],
    translation: "MouseButton5",
    voiceAgent: "MouseButton4",
  });
  const config = mgr.getMacNativeListenerConfig(MAC_SLOTS);
  assert.deepEqual(config.mouseButtons.sort(), ["MouseButton4", "MouseButton5"]);
  assert.equal(config.suppressGlobeAction, false);
});

test("slots outside the requested list are ignored", () => {
  // meeting is not wired to the macOS native listener.
  const mgr = makeManager({ dictation: "F8", meeting: "GLOBE" });
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS), {
    mouseButtons: [],
    suppressGlobeAction: false,
    watchKeys: [],
  });
});

test("no native macOS hotkeys means nothing to configure", () => {
  const mgr = makeManager({ dictation: "F8", meeting: "Control+Shift+A", voiceAgent: "" });
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS), {
    mouseButtons: [],
    suppressGlobeAction: false,
    watchKeys: [],
  });
});

// A plain key has no release source through globalShortcut on macOS (a Carbon
// hot key hides both edges from every monitor), so a Hold slot's plain keys are
// handed to the listener's event tap instead.
test("a plain key on a Hold slot is watched by the macOS listener; Tap, combos and native keys are not", (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const mgr = makeManager({
    dictation: ["F9", "Control+Shift+R"],
    voiceAgent: "F13",
    translation: "RightOption",
    meeting: "F7",
  });
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS).watchKeys, []);

  mgr.activationMode = "push";
  mgr.slotActivationModes.voiceAgent = "push";
  mgr.slotActivationModes.translation = "push";
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS).watchKeys, ["F13", "F9"]);

  // Hotkey capture must see every key: nothing is watched in listening mode.
  mgr.setListeningMode(true);
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS).watchKeys, []);
  mgr.setListeningMode(false);

  // Back on Tap, the Carbon hot key owns the key again.
  mgr.activationMode = "tap";
  assert.deepEqual(mgr.getMacNativeListenerConfig(MAC_SLOTS).watchKeys, ["F13"]);
});

test("_findSlotConflict detects a hotkey already bound to another slot's list", () => {
  const mgr = makeManager({
    dictation: ["GLOBE", "Control+Shift+R"],
    meeting: "Control+Alt",
  });
  // Re-using a dictation hotkey for the voiceAgent slot should conflict.
  const conflict = mgr._findSlotConflict("voiceAgent", "Control+Shift+R");
  assert.equal(conflict?.reason, "slot_conflict");
  assert.equal(conflict?.conflictSlot, "dictation");
  // A fresh hotkey does not conflict.
  assert.equal(mgr._findSlotConflict("voiceAgent", "F7"), null);
  // Re-checking a slot against its own hotkey is not a conflict.
  assert.equal(mgr._findSlotConflict("dictation", "GLOBE"), null);
});

test("translation slot conflicts are detected and it is never push-enabled", () => {
  const mgr = makeManager({
    dictation: "F8",
    translation: "Control+Shift+T",
  });
  // Cross-slot conflict: reusing the translation hotkey on another slot.
  const conflict = mgr._findSlotConflict("voiceAgent", "Control+Shift+T");
  assert.equal(conflict?.reason, "slot_conflict");
  assert.equal(conflict?.conflictSlot, "translation");
  // Push mode only push-enables the dictation slot, never translation.
  assert.deepEqual(mgr.getNativeListenerKeys("push"), ["F8"]);
  // Modifier-only translation hotkeys go through the native listener in tap mode.
  const mgr2 = makeManager({ translation: "Control+Alt" });
  assert.deepEqual(mgr2.getNativeListenerKeys("tap"), ["Control+Alt"]);
});
