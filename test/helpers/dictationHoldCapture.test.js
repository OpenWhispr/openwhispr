const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// main.js owns three native Hold paths — Globe/Fn, the right-side modifiers and
// the extra mouse buttons — and each one starts the recording from a delayed
// callback 150 ms after the press. Two things have to be true of all three:
//
//  * the cleanup mode is resolved at the ACCEPTED key-down, so an edit during
//    the hold cannot change the recording already under way, and the prepare
//    and the start describe the same recording;
//  * a press is refused while the rows are being committed, BEFORE it claims
//    the press owner or schedules the start — a claim made here would be acted
//    on by a callback that fires after the commit cleared the gate.
//
// The handlers are run as the real source, sliced out of main.js, with the
// native and window boundaries faked. Nothing here touches this machine.

const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");

function handlerSource(name, nextName) {
  const start = main.indexOf(`    globeKeyManager.on("${name}",`);
  assert.notEqual(start, -1, `${name} handler not found`);
  const end = main.indexOf(`    globeKeyManager.on("${nextName}",`, start);
  assert.notEqual(end, -1, `${nextName} handler not found`);
  return main.slice(start, end);
}

// `modes` is read live, so a test can change it mid-hold exactly as a commit
// would and then check which value the delayed start used.
function runHandler({ source, trigger, hotkeys, modes, activationMode, committing = false }) {
  const events = [];
  const owners = [];
  const timers = [];
  let handler;

  const windowManager = {
    mainWindow: {},
    controlPanelWindow: null,
    getActivationMode: () => activationMode,
    isDictationProcessing: () => false,
    isHotkeyCommitInFlight: () => committing,
    resolveCleanupOverride: (hotkey) => modes.get(hotkey) ?? null,
    showDictationPanel: () => {},
    setNativePressOwner: (id) => owners.push(id),
    clearNativePressOwner: () => {},
    // Only the override is recorded: the payload object belongs to the vm
    // realm, so comparing it directly fails on prototype identity alone.
    sendPrepareDictation: (payload) => events.push(["prepare", payload?.cleanupOverride ?? null]),
    sendStartDictation: (payload) => events.push(["start", payload?.cleanupOverride ?? null]),
    sendToggleDictation: (payload) => events.push(["toggle", payload?.cleanupOverride ?? null]),
    sendToggleVoiceAgent: () => {},
    sendToggleTranslation: () => {},
  };

  const context = {
    globeKeyManager: {
      on: (name, fn) => {
        if (!handler) handler = fn;
      },
    },
    hotkeyManager: {
      // The primary row, deliberately NOT the row these presses match.
      getCurrentHotkey: () => hotkeys[0],
      getSlotHotkeys: (slot) => (slot === "dictation" ? hotkeys : []),
      slotHasHotkey: (slot, hotkey) => slot === "dictation" && hotkeys.includes(hotkey),
      isInListeningMode: () => false,
    },
    windowManager,
    isLiveWindow: (win) => Boolean(win),
    isGlobeLikeHotkey: (hotkey) => hotkey === "GLOBE",
    isMouseButtonHotkey: (hotkey) => String(hotkey).startsWith("Mouse"),
    debugLogger: { debug() {}, warn() {} },
    textEditMonitor: null,
    setTimeout: (fn) => timers.push(fn),
    MIN_HOLD_DURATION_MS: 150,
    POST_STOP_COOLDOWN_MS: 300,
    globeKeyDownTime: 0,
    globeKeyIsRecording: false,
    globeLastStopTime: 0,
    rightModActiveKey: null,
    rightModDownTime: 0,
    rightModIsRecording: false,
    rightModLastStopTime: 0,
    mouseButtonActiveButton: null,
    mouseButtonDownTime: 0,
    mouseButtonIsRecording: false,
    mouseButtonLastStopTime: 0,
  };

  vm.runInNewContext(source, context);
  assert.ok(handler, "the handler registered itself");

  return {
    owners,
    events,
    press: async () => {
      await handler(trigger);
      return { events: [...events], owners: [...owners], timers: timers.length };
    },
    runDelayed: async () => {
      for (const timer of timers.splice(0)) await timer();
      return [...events];
    },
  };
}

// Globe, right modifier and mouse button, each matching the SECOND dictation
// row — the one with its own cleanup mode.
const PATHS = {
  globe: {
    source: handlerSource("globe-down", "globe-up"),
    trigger: undefined,
    hotkeys: ["Control+F8", "GLOBE"],
    matched: "GLOBE",
  },
  "right modifier": {
    source: handlerSource("right-modifier-down", "right-modifier-up"),
    trigger: "RightCommand",
    hotkeys: ["Control+F8", "RightCommand"],
    matched: "RightCommand",
    owner: "right-modifier",
  },
  "mouse button": {
    source: handlerSource("mouse-button-down", "mouse-button-up"),
    trigger: "Mouse4",
    hotkeys: ["Control+F8", "Mouse4"],
    matched: "Mouse4",
    owner: "mouse-button",
  },
};

for (const [name, config] of Object.entries(PATHS)) {
  const owner = config.owner || "globe";

  test(`${name} Hold resolves the mode at key-down and keeps it across the delay`, async () => {
    const modes = new Map([
      ["Control+F8", "raw"],
      [config.matched, "cleaned"],
    ]);
    const run = runHandler({ ...config, modes, activationMode: "push" });

    const atPress = await run.press();
    assert.deepEqual(
      atPress.events,
      [["prepare", "cleaned"]],
      "the prepare carries the matched row's mode"
    );
    assert.deepEqual(atPress.owners, [owner], "the press is registered as a binding owner");

    // A commit lands while the key is still down. The recording already under
    // way must keep the mode it was started with.
    modes.set(config.matched, "raw");
    const afterDelay = await run.runDelayed();

    assert.deepEqual(afterDelay.at(-1), ["start", "cleaned"]);
  });

  test(`${name} Tap uses the matched row's mode, not the first row's`, async () => {
    const modes = new Map([
      ["Control+F8", "raw"],
      [config.matched, "cleaned"],
    ]);
    const run = runHandler({ ...config, modes, activationMode: "tap" });

    const atPress = await run.press();

    assert.deepEqual(atPress.events, [["toggle", "cleaned"]]);
  });

  test(`${name} claims nothing while a row commit is in flight`, async () => {
    const run = runHandler({
      ...config,
      modes: new Map([[config.matched, "cleaned"]]),
      activationMode: "push",
      committing: true,
    });

    const atPress = await run.press();

    assert.deepEqual(atPress.events, [], "no prepare while the keys are changing");
    assert.deepEqual(atPress.owners, [], "no press owner is claimed");
    assert.equal(atPress.timers, 0, "and no delayed start survives the commit");
  });
}
