const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Same stub set as windowManagerAssistantPanel.test.js: WindowManager pulls in
// electron + sibling managers at require time.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({}),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        on: () => undefined,
      },
      BrowserWindow: class FakeBrowserWindow {
        constructor() {
          this.webContents = { on: () => undefined, send: () => undefined };
        }
        on() {}
        isDestroyed() {
          return false;
        }
      },
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger")
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
      isInListeningMode() {
        return false;
      }
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager")
    return class {
      cleanup() {}
    };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      AUTO_END_NOTIFICATION_WINDOW_SIZE: { width: 620, height: 116 },
      getMeetingNotificationWindowSize: () => ({ width: 392, height: 92 }),
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (bounds) => bounds,
        getMainWindowPosition: (_display, size) => ({ x: 0, y: 0, ...size }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (size) => size,
      fitAssistantContentWindowToWorkArea: (height) => ({ width: 466, height }),
      fitDictationErrorWindowToWorkArea: (size) => size,
      fitDictationErrorContentWindowToWorkArea: (height) => ({ width: 466, height }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function makeManager() {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  const sent = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    getCurrentHotkey: () => "F8",
    supportsPushToTalk: () => true,
    getSlotHotkey: () => "F9",
    setSlotActivationMode: async () => true,
  };
  manager.showDictationPanel = () => undefined;
  manager.hideDictationPanel = () => {
    sent.push({ channel: "__hide-panel" });
  };
  return { manager, sent };
}

const channels = (sent) => sent.map((message) => message.channel);
const useGestureTimers = (t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

function macManager(t, inputKind) {
  useGestureTimers(t);
  t.mock.timers.tick(100000);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", originalPlatform));
  const result = makeManager();
  result.manager._cachedActivationMode = "push";
  result.manager._cachedSlotActivationModes = { voiceAgent: "push", translation: "push" };
  result.callback = result.manager.createHotkeyCallback(inputKind);
  return result;
}

async function latchCompound(t, manager, callback, inputKind, gap = 170) {
  await callback("Command+Period");
  manager.setDictationLifecycleState("preparing", inputKind);
  t.mock.timers.tick(80);
  manager.handleMacPushModifierUp("command");
  t.mock.timers.tick(gap);
  await callback("Command+Period");
  manager.setDictationLifecycleState("recording", inputKind);
  assert.equal(manager.isHandsFreeActive(inputKind), true);
}

for (const inputKind of ["dictation", "assistant", "translation"]) {
  test(`${inputKind}: held latching and stopping chords ignore repeats until modifier release`, async (t) => {
    const { manager, sent, callback } = macManager(t, inputKind);
    await latchCompound(t, manager, callback, inputKind);
    for (const repeatDelay of [225, 90, 90, 375, 90]) {
      t.mock.timers.tick(repeatDelay);
      await callback("Command+Period");
    }
    assert.equal(manager.isHandsFreeActive(inputKind), true);
    assert.equal(channels(sent).filter((channel) => channel === "hands-free-latched").length, 1);
    assert.equal(channels(sent).includes("stop-dictation"), false);
    manager.handleMacPushModifierUp("shift");
    assert.equal(manager.macCompoundPushState?.active, true);
    manager.handleMacPushModifierUp("command");
    assert.equal(manager.isHandsFreeActive(inputKind), true);
    assert.equal(manager.macCompoundPushState, null);

    t.mock.timers.tick(200);
    await callback("Command+Period");
    assert.equal(manager.isHandsFreeActive(inputKind), false);
    assert.equal(channels(sent).filter((channel) => channel === "stop-dictation").length, 1);
    sent.length = 0;
    manager.setDictationLifecycleState("processing", inputKind);
    t.mock.timers.tick(375);
    await callback("Command+Period");
    manager.setDictationLifecycleState("idle");
    t.mock.timers.tick(375);
    await callback("Command+Period");
    manager.handleMacPushModifierUp("command");
    assert.deepEqual(sent, []);
  });

  test(`${inputKind}: force-clearing a latched physical chord does not cancel preparation`, async (t) => {
    const { manager, sent, callback } = macManager(t, inputKind);
    await latchCompound(t, manager, callback, inputKind);
    sent.length = 0;
    manager.forceStopMacCompoundPush();
    assert.deepEqual(sent, []);
    assert.equal(manager.isHandsFreeActive(inputKind), true);
    assert.equal(manager.macCompoundPushState, null);
  });
}

for (const secondPressTime of [146, 177]) {
  test(`a genuine second chord at ${secondPressTime}ms still latches`, async (t) => {
    const { manager, callback } = macManager(t, "dictation");
    await latchCompound(t, manager, callback, "dictation", secondPressTime - 80);
    manager.handleMacPushModifierUp("command");
    assert.equal(manager.isHandsFreeActive("dictation"), true);
  });
}

test("normal compound Hold retains preparation, threshold start, and matched release", async (t) => {
  const { manager, sent, callback } = macManager(t, "assistant");
  await callback("Command+Period");
  t.mock.timers.tick(149);
  assert.deepEqual(channels(sent), ["prepare-dictation"]);
  manager.handleMacPushModifierUp("shift");
  t.mock.timers.tick(1);
  assert.deepEqual(channels(sent), ["prepare-dictation", "start-dictation"]);
  manager.handleMacPushModifierUp("command");
  assert.deepEqual(channels(sent), [
    "prepare-dictation",
    "start-dictation",
    "stop-dictation",
    "hold-dictation-ended",
  ]);
  assert.equal(manager.macCompoundPushState, null);
});

test("quick compound release expires its preparation without starting recording", async (t) => {
  const { manager, sent, callback } = macManager(t, "dictation");
  await callback("Command+Period");
  manager.setDictationLifecycleState("preparing", "dictation");
  t.mock.timers.tick(80);
  manager.handleMacPushModifierUp("command");
  t.mock.timers.tick(1000);
  assert.equal(channels(sent).includes("cancel-dictation-preparation"), true);
  assert.equal(channels(sent).includes("start-dictation"), false);
});

test("settings reset clears a physical-only chord and stops its latch once", async (t) => {
  const { manager, sent, callback } = macManager(t, "translation");
  await latchCompound(t, manager, callback, "translation");
  sent.length = 0;
  manager.resetNativePushState();
  manager.handleMacPushModifierUp("command");
  assert.deepEqual(channels(sent), ["stop-dictation"]);
  assert.equal(manager.macCompoundPushState, null);
});

test("capture and a busy assistant panel prevent compound press ownership", async (t) => {
  const { manager, sent, callback } = macManager(t, "assistant");
  manager.hotkeyManager.isInListeningMode = () => true;
  await callback("Command+Period");
  manager.hotkeyManager.isInListeningMode = () => false;
  manager._assistantPanelOpen = true;
  manager._assistantPanelBusy = true;
  await callback("Command+Period");
  assert.equal(manager.macCompoundPushState, null);
  assert.deepEqual(sent, []);
});

test("a compound second press cannot latch or stop another kind's recording", async (t) => {
  const { manager, sent, callback } = macManager(t, "assistant");
  await callback("Command+Period");
  manager.setDictationLifecycleState("preparing", "assistant");
  t.mock.timers.tick(80);
  manager.handleMacPushModifierUp("command");
  manager.setDictationLifecycleState("recording", "translation");
  sent.length = 0;
  t.mock.timers.tick(170);
  await callback("Command+Period");
  assert.equal(manager.isHandsFreeActive("assistant"), false);
  assert.equal(channels(sent).includes("hands-free-latched"), false);
  assert.equal(channels(sent).includes("stop-dictation"), false);
  assert.notEqual(manager.macCompoundPushState?.gestureHandled, true);
});

function bindGlobeHandlers(manager, slot) {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const { EventEmitter } = require("node:events");
  const source = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
  const start = source.indexOf("    let globeKeyDownTime = 0;");
  const end = source.indexOf('    globeKeyManager.on("modifier-up",', start);
  assert.ok(start > 0 && end > start);
  manager.hotkeyManager.getSlotHotkeys = (requested) => (requested === slot ? ["GLOBE"] : []);
  const emitter = new EventEmitter();
  const context = vm.createContext({
    windowManager: manager,
    hotkeyManager: manager.hotkeyManager,
    globeKeyManager: emitter,
    debugLogger: { debug() {} },
    textEditMonitor: null,
    isLiveWindow: (win) => Boolean(win && !win.isDestroyed()),
    isGlobeLikeHotkey: (key) => key === "GLOBE",
    Date,
    setTimeout,
    ipcMain: emitter,
    syncMacNativeHotkeyConfiguration: () => undefined,
  });
  vm.runInContext(source.slice(start, end), context);
  const resetStart = source.indexOf('    ipcMain.on("hotkey-changed",', end);
  const resetEnd = source.indexOf("\n    });", resetStart) + "\n    });".length;
  assert.ok(resetStart > end && resetEnd > resetStart);
  vm.runInContext(source.slice(resetStart, resetEnd), context);
  return emitter;
}

function latchGlobe(t, manager, emitter, kind) {
  emitter.emit("globe-down");
  manager.setDictationLifecycleState("preparing", kind);
  t.mock.timers.tick(80);
  emitter.emit("globe-up");
  t.mock.timers.tick(170);
  emitter.emit("globe-down");
  manager.setDictationLifecycleState("recording", kind);
  emitter.emit("globe-up");
  assert.equal(manager.isHandsFreeActive(kind), true);
}

for (const [slot, kind] of [
  ["dictation", "dictation"],
  ["voiceAgent", "assistant"],
  ["translation", "translation"],
]) {
  test(`${kind}: actual main Globe callbacks preserve an established latch during Fn navigation`, (t) => {
    const { manager, sent } = macManager(t, kind);
    const emitter = bindGlobeHandlers(manager, slot);
    latchGlobe(t, manager, emitter, kind);
    t.mock.timers.tick(5000);
    sent.length = 0;
    emitter.emit("globe-down");
    t.mock.timers.tick(20);
    emitter.emit("globe-interrupted");
    emitter.emit("globe-up");
    assert.equal(manager.isHandsFreeActive(kind), true);
    assert.deepEqual(sent, []);
  });

  test(`${kind}: actual main Globe callbacks stop a latch only on bare Fn release`, (t) => {
    const { manager, sent } = macManager(t, kind);
    const emitter = bindGlobeHandlers(manager, slot);
    latchGlobe(t, manager, emitter, kind);
    t.mock.timers.tick(5000);
    sent.length = 0;
    emitter.emit("globe-down");
    assert.deepEqual(sent, []);
    emitter.emit("globe-up");
    emitter.emit("globe-up");
    assert.equal(manager.isHandsFreeActive(kind), false);
    assert.deepEqual(channels(sent), ["stop-dictation"]);
  });

  test(`${kind}: Fn navigation still cancels a just-created accidental latch`, (t) => {
    const { manager, sent } = macManager(t, kind);
    const emitter = bindGlobeHandlers(manager, slot);
    latchGlobe(t, manager, emitter, kind);
    sent.length = 0;
    t.mock.timers.tick(100);
    emitter.emit("globe-down");
    emitter.emit("globe-interrupted");
    emitter.emit("globe-up");
    assert.equal(manager.isHandsFreeActive(kind), false);
    assert.equal(channels(sent).includes("cancel-hotkey-pressed"), true);
    assert.equal(channels(sent).includes("stop-dictation"), false);
  });

  test(`${kind}: actual main Globe Hold starts at threshold and stops on release`, (t) => {
    const { manager, sent } = macManager(t, kind);
    const emitter = bindGlobeHandlers(manager, slot);
    emitter.emit("globe-down");
    t.mock.timers.tick(149);
    assert.deepEqual(channels(sent), ["prepare-dictation"]);
    t.mock.timers.tick(1);
    assert.deepEqual(channels(sent), ["prepare-dictation", "start-dictation"]);
    emitter.emit("globe-up");
    assert.deepEqual(channels(sent), [
      "prepare-dictation",
      "start-dictation",
      "stop-dictation",
      "hold-dictation-ended",
    ]);
  });

  test(`${kind}: a quick Globe release expires preparation without recording`, (t) => {
    const { manager, sent } = macManager(t, kind);
    const emitter = bindGlobeHandlers(manager, slot);
    emitter.emit("globe-down");
    manager.setDictationLifecycleState("preparing", kind);
    t.mock.timers.tick(80);
    emitter.emit("globe-up");
    t.mock.timers.tick(1000);
    assert.equal(channels(sent).includes("cancel-dictation-preparation"), true);
    assert.equal(channels(sent).includes("start-dictation"), false);
  });

  test(`${kind}: capture, processing and cleared pending stops produce no extra action`, (t) => {
    const { manager, sent } = macManager(t, kind);
    const emitter = bindGlobeHandlers(manager, slot);
    manager.hotkeyManager.isInListeningMode = () => true;
    emitter.emit("globe-down");
    t.mock.timers.tick(200);
    emitter.emit("globe-up");
    manager.hotkeyManager.isInListeningMode = () => false;
    manager.setDictationLifecycleState("processing", kind);
    emitter.emit("globe-down");
    emitter.emit("globe-up");
    assert.deepEqual(sent, []);
    manager.setDictationLifecycleState("idle");
    latchGlobe(t, manager, emitter, kind);
    t.mock.timers.tick(5000);
    emitter.emit("globe-down");
    emitter.emit("hotkey-changed");
    sent.length = 0;
    emitter.emit("globe-up");
    assert.deepEqual(sent, []);
    assert.equal(manager.isHandsFreeActive(kind), false);
  });
}

test("an unbound Globe emits no recording action", (t) => {
  const { manager, sent } = macManager(t, "dictation");
  const emitter = bindGlobeHandlers(manager, "unused");
  emitter.emit("globe-down");
  t.mock.timers.tick(500);
  emitter.emit("globe-up");
  assert.deepEqual(sent, []);
});
