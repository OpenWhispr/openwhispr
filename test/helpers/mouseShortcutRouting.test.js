const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../../main.js"), "utf8");
function setup() {
  const handlers = {};
  const calls = [];
  const timers = [];
  const state = { listening: true, focused: true, mode: "toggle", hotkey: "MouseButton3" };
  const panel = {
    isFocused: () => state.focused,
    webContents: { send: (...args) => calls.push(args) },
  };
  const windowManager = {
    controlPanelWindow: panel,
    mainWindow: {},
    isDictationProcessing: () => false,
    getActivationMode: () => state.mode,
  };
  for (const name of [
    "sendToggleVoiceAgent",
    "sendToggleTranslation",
    "showDictationPanel",
    "sendPrepareDictation",
    "sendStartDictation",
    "sendStopDictation",
    "sendToggleDictation",
    "sendCancelDictationPreparation",
    "hideDictationPanel",
  ])
    windowManager[name] = () => calls.push(name);
  const start = source.indexOf("    // Middle and auxiliary mouse buttons");
  const end = source.indexOf("    // If accessibility is missing", start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    globeKeyManager: {
      on: (name, fn) => {
        handlers[name] = fn;
      },
    },
    hotkeyManager: {
      isInListeningMode: () => state.listening,
      slotHasHotkey: (slot, key) => slot === (state.slot || "dictation") && key === state.hotkey,
    },
    isMouseButtonHotkey: (key) => /^MouseButton(?:[3-9]|[12][0-9]|3[0-2])$/.test(key),
    capturedMouseButtons: new Set(),
    windowManager,
    isLiveWindow: Boolean,
    meetingHotkeyCallback: () => calls.push("meeting"),
    textEditMonitor: { captureTargetPid: () => calls.push("captureTarget") },
    MIN_HOLD_DURATION_MS: 150,
    POST_STOP_COOLDOWN_MS: 300,
    setTimeout: (fn) => timers.push(fn),
    Date,
    debugLogger: { debug() {} },
  });
  return {
    state,
    calls,
    timers,
    down: handlers["mouse-button-down"],
    up: handlers["mouse-button-up"],
  };
}
test("capture accepts an auxiliary release only after its press, without dictating", async () => {
  const x = setup();
  await x.up("MouseButton8");
  assert.deepEqual(x.calls, []);
  await x.down("MouseButton8");
  assert.deepEqual(x.calls, []);
  await x.up("MouseButton8");
  assert.equal(x.calls.length, 1);
  assert.deepEqual(Array.from(x.calls[0]), ["mouse-shortcut-captured", "MouseButton8"]);
});
test("capture ignores primary buttons and releases after focus leaves", async () => {
  const x = setup();
  await x.down("MouseButton1");
  await x.up("MouseButton1");
  await x.down("MouseButton3");
  x.state.focused = false;
  await x.up("MouseButton3");
  assert.deepEqual(x.calls, []);
});
test("middle button uses normal toggle delivery outside capture", async () => {
  const x = setup();
  x.state.listening = false;
  await x.down("MouseButton3");
  await x.up("MouseButton3");
  assert.deepEqual(x.calls, ["captureTarget", "sendToggleDictation"]);
});
test("additional button push-to-talk starts once and stops on release", async () => {
  const x = setup();
  Object.assign(x.state, { listening: false, mode: "push", hotkey: "MouseButton8" });
  await x.down("MouseButton8");
  x.timers[0]();
  await x.up("MouseButton8");
  assert.deepEqual(x.calls, [
    "captureTarget",
    "showDictationPanel",
    "sendPrepareDictation",
    "sendStartDictation",
    "sendStopDictation",
  ]);
});
test("short push-to-talk click cancels preparation without starting", async () => {
  const x = setup();
  Object.assign(x.state, { listening: false, mode: "push" });
  await x.down("MouseButton3");
  await x.up("MouseButton3");
  x.timers[0]();
  assert.deepEqual(x.calls, [
    "captureTarget",
    "showDictationPanel",
    "sendPrepareDictation",
    "sendCancelDictationPreparation",
    "hideDictationPanel",
  ]);
});

test("mouse shortcuts route the manual meeting slot", async () => {
  const x = setup();
  Object.assign(x.state, { listening: false, slot: "meeting" });
  await x.down("MouseButton3");
  await x.up("MouseButton3");
  assert.deepEqual(x.calls, ["meeting"]);
});
