const test = require("node:test");
const assert = require("node:assert/strict");

const HotkeyManager = require("../../src/helpers/hotkeyManager.js");

// Build a manager with an explicit set of slot hotkeys, independent of the
// platform default so the assertions are deterministic everywhere.
const makeManager = (slots) => {
  const mgr = new HotkeyManager();
  mgr.slots.clear();
  for (const [name, hotkey] of Object.entries(slots)) {
    mgr.slots.set(name, { hotkey, callback: null, accelerator: null });
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
