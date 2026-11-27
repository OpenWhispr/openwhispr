const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  registerMacDictationHotkeys,
  registerMacKeyboardMonitor,
  registerRawDictationHotkeys,
} = require("../../src/helpers/dictationHotkeyWiring");

// WindowManager pulls in electron and its sibling managers at require time; only
// the pieces the push-to-talk state machine touches need to behave.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { on: () => undefined, getPrimaryDisplay: () => ({}) },
      BrowserWindow: class {},
      Menu: {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") {
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  }
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {};
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: { COMPACT: {}, EXPANDED: {} },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: () => ({ x: 0, y: 0 }),
        getNotificationPosition: () => ({ x: 0, y: 0 }),
      },
      fitAssistantWindowToWorkArea: (s) => s,
      fitAssistantContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      fitDictationErrorWindowToWorkArea: (s) => s,
      fitDictationErrorContentWindowToWorkArea: (h) => ({ width: 466, height: h }),
      resolveHorizontalWindowDirection: () => "right",
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
const HotkeyManager = require("../../src/helpers/hotkeyManager");
Module._load = originalLoad;

// Returns the manager plus the channels it pushed to the renderer, in order.
function makeManager() {
  const sent = [];
  const manager = new WindowManager();
  const hotkeyEvents = [];
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    getSlotHotkeys: () => ["Control+Space"],
    getDictationDoublePressUnavailableReason: () => null,
    logHotkeyEvent: (...args) => hotkeyEvents.push(args),
  };
  // Before mainWindow is attached, so its own teardown sends stay out of `sent`.
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  manager.showDictationPanel = () => undefined;
  manager.isDictationProcessing = () => false;
  const hides = [];
  manager.hideDictationPanel = () => hides.push(true);
  return {
    manager,
    sent,
    hides,
    hotkeyEvents,
    channels: () => sent.map((entry) => entry.channel),
  };
}

function startPush(t) {
  const harness = makeManager();
  harness.manager.startWindowsPushToTalk("Control+Space");
  t.mock.timers.tick(150); // MIN_HOLD_DURATION_MS — recording actually begins
  assert.deepEqual(harness.channels(), ["prepare-dictation", "start-dictation"]);
  return harness;
}

test("a physical release stops dictation without reporting a forced stop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { manager, channels } = startPush(t);
  manager.handleWindowsPushKeyUp("Control+Space");

  assert.deepEqual(channels(), ["prepare-dictation", "start-dictation", "stop-dictation"]);
});

// The safety ceiling ends the push while the trigger keys are still physically
// down. The renderer has to know, or it pastes into those held modifiers and the
// transcript is lost with no error (#2047).
test("the safety ceiling reports a forced stop before the stop it causes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { sent, channels } = startPush(t);
  t.mock.timers.tick(300_000); // MAX_PUSH_DURATION_MS

  assert.deepEqual(channels(), [
    "prepare-dictation",
    "start-dictation",
    "dictation-force-stopped",
    "stop-dictation",
  ]);
  assert.deepEqual(sent.at(-2).payload, { reason: "timeout" });
});

// Driven through the real ceiling rather than by calling forceStop directly, so
// the "timeout" argument at the timer itself stays pinned.
test("the macOS compound ceiling reports a forced stop on the same channel", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const harness = makeManager();
  harness.manager.startMacCompoundPushToTalk("Control+Option");
  t.mock.timers.tick(150);
  assert.deepEqual(harness.channels(), ["prepare-dictation", "start-dictation"]);

  t.mock.timers.tick(300_000);

  assert.deepEqual(harness.channels(), [
    "prepare-dictation",
    "start-dictation",
    "dictation-force-stopped",
    "stop-dictation",
  ]);
  assert.deepEqual(harness.sent.at(-2).payload, { reason: "timeout" });
});

// globalShortcut reports the press but never the release, so the modifier release
// that ends the hold is what tells the debug log the key came up.
test("releasing a macOS compound hold logs the hotkey's release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const harness = makeManager();
  harness.manager.startMacCompoundPushToTalk("Control+Option");
  t.mock.timers.tick(150);
  harness.manager.handleMacPushModifierUp("shift");
  harness.manager.handleMacPushModifierUp("control");

  assert.deepEqual(harness.hotkeyEvents, [["macos-native", "up", "Control+Option"]]);
  assert.equal(harness.channels().at(-1), "stop-dictation");
});

// The transcript arrives seconds after the stop and is surfaced by a toast inside
// this window, so hiding it here would render the recovery pill invisibly.
test("a forced stop leaves the window up for the transcript still being processed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const mac = makeManager();
  mac.manager.startMacCompoundPushToTalk("Control+Option");
  t.mock.timers.tick(150);
  t.mock.timers.tick(300_000);
  assert.deepEqual(mac.hides, [], "macOS compound");

  const win = startPush(t);
  t.mock.timers.tick(300_000);
  assert.deepEqual(win.hides, [], "windows/linux");
});

// The complementary half: with nothing being transcribed there is no pill to
// keep the window open for, so it still goes away.
test("a forced stop before recording began still hides the window", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const mac = makeManager();
  mac.manager.startMacCompoundPushToTalk("Control+Option");
  t.mock.timers.tick(100); // still inside MIN_HOLD_DURATION_MS
  mac.manager.forceStopMacCompoundPush("timeout");

  assert.deepEqual(mac.channels(), [
    "prepare-dictation",
    "dictation-force-stopped",
    "cancel-dictation-preparation",
  ]);
  assert.deepEqual(mac.hides, [true]);
});

// Changing the hotkey or activation mode mid-push ends it without a release too.
test("a settings-driven reset reports a forced stop, not a release", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { manager, sent, channels } = startPush(t);
  manager.resetWindowsPushState();

  assert.deepEqual(channels(), [
    "prepare-dictation",
    "start-dictation",
    "dictation-force-stopped",
    "stop-dictation",
  ]);
  assert.deepEqual(sent.at(-2).payload, { reason: "reset" });
});

function installCaptureHandler(manager, platform) {
  manager.hotkeyManager = new HotkeyManager();
  manager.hotkeyManager.currentHotkey = "RightControl";
  manager._cachedActivationMode = "push";
  manager._nativeKeyListenersReady = true;
  const nativeKeyManager = { stop() {}, setKeys() {} };
  manager.windowsKeyManager = manager.linuxKeyManager = nativeKeyManager;
  const owner = {
    windowManager: manager,
    windowsKeyManager: nativeKeyManager,
    linuxKeyManager: nativeKeyManager,
  };
  const handlers = new Map();
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf('    ipcMain.handle("set-hotkey-listening-mode"');
  const end = source.indexOf('    ipcMain.handle("get-hotkey-mode-info"', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(`(function () { ${source.slice(start, end)} }).call(owner)`, {
    owner,
    process: { platform },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), emit() {} },
    BrowserWindow: { fromWebContents: () => ({}) },
    debugLogger: { log() {}, warn() {} },
    require(name) {
      if (name === "./hotkeyManager") return HotkeyManager;
      if (name === "electron") return { globalShortcut: {} };
      throw new Error(`Unexpected capture dependency: ${name}`);
    },
  });
  const handler = handlers.get("set-hotkey-listening-mode");
  return (enabled) => handler({ sender: {} }, enabled);
}

for (const platform of ["win32", "linux"]) {
  for (const phase of ["preparing", "recording"]) {
    test(`${platform} capture ends a ${phase} Hold and cancellation allows the next Hold`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.after(() => t.mock.timers.reset());
      const { manager, sent, channels, hides } = makeManager();
      const setCapture = installCaptureHandler(manager, platform);
      manager.startWindowsPushToTalk("RightControl");
      if (phase === "recording") t.mock.timers.tick(150);

      await setCapture(true);
      assert.equal(manager.winPushState, null, "capture cannot leave an orphaned Hold");
      assert.equal(manager.hotkeyManager.isInListeningMode(), true);
      assert.deepEqual(
        channels(),
        phase === "recording"
          ? ["prepare-dictation", "start-dictation", "dictation-force-stopped", "stop-dictation"]
          : ["prepare-dictation", "dictation-force-stopped", "cancel-dictation-preparation"]
      );
      assert.deepEqual(sent.at(-2).payload, { reason: "reset" });
      assert.deepEqual(hides, phase === "preparing" ? [true] : []);

      const stoppedChannels = channels();
      await setCapture(true);
      t.mock.timers.tick(300_000);
      assert.deepEqual(channels(), stoppedChannels, "duplicate capture and old timers stay inert");

      await setCapture(false);
      assert.equal(manager.hotkeyManager.isInListeningMode(), false);
      assert.deepEqual(
        channels(),
        stoppedChannels,
        "cancelling capture does not restart recording"
      );
      manager.startWindowsPushToTalk("RightControl");
      t.mock.timers.tick(150);
      manager.handleWindowsPushKeyUp("RightControl");
      assert.deepEqual(channels().slice(stoppedChannels.length), [
        "prepare-dictation",
        "start-dictation",
        "stop-dictation",
      ]);
      assert.equal(manager.winPushState, null);
    });
  }
}

test("macOS capture does not invoke the Windows/Linux Hold reset", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  const { manager, channels } = makeManager();
  const setCapture = installCaptureHandler(manager, "darwin");
  manager.resetWindowsPushState = () => assert.fail("Windows/Linux reset reached macOS");
  manager.startMacCompoundPushToTalk("Control+Option");
  t.mock.timers.tick(150);
  const activePush = manager.macCompoundPushState;
  await setCapture(true);
  await setCapture(false);
  assert.equal(manager.macCompoundPushState, activePush);
  assert.deepEqual(channels(), ["prepare-dictation", "start-dictation"]);
});

test("two short taps latch Hold dictation until the next matching release", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  t.after(() => t.mock.timers.reset());
  const { manager, channels } = makeManager();
  const hotkey = "Control+Space";
  manager._cachedActivationMode = "push-double-tap";

  manager.startWindowsPushToTalk(hotkey);
  t.mock.timers.tick(60);
  manager.handleWindowsPushKeyUp(hotkey);
  assert.equal(channels().filter((channel) => channel === "start-dictation").length, 0);

  t.mock.timers.tick(120);
  manager.startWindowsPushToTalk(hotkey);
  t.mock.timers.tick(60);
  manager.handleWindowsPushKeyUp(hotkey);
  assert.equal(channels().filter((channel) => channel === "start-dictation").length, 1);
  assert.equal(channels().includes("stop-dictation"), false);

  manager.startWindowsPushToTalk(hotkey);
  assert.equal(channels().includes("stop-dictation"), false);
  manager.handleWindowsPushKeyUp(hotkey);
  assert.equal(channels().filter((channel) => channel === "stop-dictation").length, 1);
});

function makeDoublePressHarness(t, mode = "push-double-tap") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  t.after(() => t.mock.timers.reset());
  const harness = makeManager();
  harness.manager._cachedActivationMode = mode;
  const tap = (hotkey = "Control+Space", quietGapMs = 120) => {
    harness.manager.startWindowsPushToTalk(hotkey);
    t.mock.timers.tick(60);
    harness.manager.handleWindowsPushKeyUp(hotkey);
    t.mock.timers.tick(quietGapMs);
  };
  return { ...harness, tap };
}

test("quick taps in ordinary Hold and Tap never latch", async (t) => {
  for (const mode of ["push", "tap"]) {
    await t.test(mode, (t) => {
      const { channels, tap } = makeDoublePressHarness(t, mode);
      tap();
      tap();
      assert.equal(channels().includes("start-dictation"), false);
    });
  }
});

test("unavailable macOS keyboard monitoring prevents a hands-free start", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  manager.canObserveHandsFreeInput = () => false;

  manager.tryStartHandsFreeDictation("RightOption");
  t.mock.timers.tick(150);
  manager.tryStartHandsFreeDictation("RightOption");
  assert.equal(channels().includes("start-dictation"), false);

  manager.canObserveHandsFreeInput = () => true;
  t.mock.timers.tick(150);
  assert.equal(manager.tryStartHandsFreeDictation("RightOption"), false);
  t.mock.timers.tick(150);
  assert.equal(manager.tryStartHandsFreeDictation("RightOption"), true);
});

test("a formerly saved unsupported binding cannot latch before startup fallback", (t) => {
  const { manager, sent, channels, tap } = makeDoublePressHarness(t);
  const hotkey = "RightControl";
  manager.hotkeyManager.getDictationDoublePressUnavailableReason = (binding) =>
    binding === hotkey ? "Double-tap needs a non-modifier key" : null;

  tap(hotkey);
  tap(hotkey);
  assert.equal(channels().includes("start-dictation"), false);

  manager.startWindowsPushToTalk(hotkey);
  t.mock.timers.tick(150);
  manager.handleWindowsPushKeyUp(hotkey);
  assert.deepEqual(sent.slice(-2), [
    { channel: "start-dictation", payload: undefined },
    { channel: "stop-dictation", payload: undefined },
  ]);
});

test("confirmed macOS monitor loss stops hands-free and refreshes the picker", (t) => {
  const { manager, channels, tap } = makeDoublePressHarness(t);
  const callbacks = new Map();
  const broadcasts = [];
  const fallbacks = [];
  const globeKeyManager = {
    keyboardMonitorStatus: "ready",
    get hasKeyboardMonitor() {
      return this.keyboardMonitorStatus === "ready";
    },
    on(event, callback) {
      callbacks.set(event, callback);
    },
  };
  registerMacKeyboardMonitor({
    windowManager: manager,
    globeKeyManager,
    broadcastToWindows: (event) => broadcasts.push(event),
    onUnavailable: () => fallbacks.push("Hold"),
  });
  const setStatus = (status) => {
    globeKeyManager.keyboardMonitorStatus = status;
    callbacks.get("keyboard-monitor-status-changed")(status);
  };
  tap();
  tap();
  assert.equal(channels().at(-1), "start-dictation");

  setStatus("pending");
  assert.equal(channels().at(-1), "stop-dictation");
  assert.deepEqual(fallbacks, [], "a restart in progress must not change mode");

  setStatus("unavailable");
  assert.deepEqual(fallbacks, ["Hold"]);
  setStatus("ready");
  assert.deepEqual(broadcasts, Array(3).fill("hotkey-mode-info-changed"));
});

test("different keys and expired taps do not combine across bindings or intervals", (t) => {
  const { channels, tap } = makeDoublePressHarness(t);
  tap("Control+Space");
  tap("Control+F11", 401);
  tap("Control+F11");
  assert.equal(channels().includes("start-dictation"), false);
});

test("a first tap followed by a full Hold stops when the key is released", (t) => {
  const { manager, channels, tap } = makeDoublePressHarness(t);
  tap();
  manager.startWindowsPushToTalk("Control+Space");
  t.mock.timers.tick(150);
  manager.handleWindowsPushKeyUp("Control+Space");
  assert.deepEqual(channels().slice(-3), [
    "prepare-dictation",
    "start-dictation",
    "stop-dictation",
  ]);
});

function installMacDictationHandlers(manager, binding) {
  const listener = new EventEmitter();
  manager.hotkeyManager.getSlotHotkeys = (slot) => (slot === "dictation" ? [binding] : []);
  manager.hotkeyManager.slotHasHotkey = (slot, key) => slot === "dictation" && key === binding;
  registerMacDictationHotkeys({
    globeKeyManager: listener,
    windowManager: manager,
    isGlobeLikeHotkey: (key) => key === "GLOBE",
    isLiveWindow: (window) => window && !window.isDestroyed(),
    debugLogger: { debug() {} },
  });
  return listener;
}

function installMacGlobeHandlers(manager) {
  const listener = installMacDictationHandlers(manager, "GLOBE");
  return (phase) => listener.emit(`globe-${phase}`);
}

test("Globe tap interruptions neither start hands-free recording nor stop an intentional latch", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const event = installMacGlobeHandlers(manager);
  const tap = (interrupted = false, gap = 100) => {
    event("down");
    t.mock.timers.tick(25);
    if (interrupted) event("tap-interrupted");
    t.mock.timers.tick(25);
    event("up");
    t.mock.timers.tick(gap);
  };

  tap(true, 320);
  tap(true, 420);
  assert.equal(channels().includes("start-dictation"), false);

  tap();
  tap();
  assert.equal(channels().at(-1), "start-dictation");

  tap(true);
  assert.equal(channels().includes("stop-dictation"), false);
  tap();
  assert.equal(channels().at(-1), "stop-dictation");
});

test("Globe tap interruptions leave ordinary Hold release behavior intact", (t) => {
  const { manager, channels } = makeDoublePressHarness(t, "push");
  const event = installMacGlobeHandlers(manager);
  event("down");
  t.mock.timers.tick(160);
  event("tap-interrupted");
  event("up");
  assert.deepEqual(channels(), ["prepare-dictation", "start-dictation", "stop-dictation"]);
});

function installNativeDictationHandlers(manager, platform) {
  const listener = new EventEmitter();
  manager.hotkeyManager.slotHasHotkey = (slot) => slot === "dictation";
  manager.hotkeyManager.isUsingNativeShortcut = () => false;
  manager.hotkeyManager.reliesOnLinuxKeyListener = () => platform === "linux";
  registerRawDictationHotkeys({
    nativeKeyManager: listener,
    windowManager: manager,
    isWindows: platform === "win32",
    isLiveWindow: (window) => window && !window.isDestroyed(),
    debugLogger: { debug() {}, warn() {} },
  });
  return listener;
}

for (const platform of ["win32", "linux"]) {
  test(`${platform} legacy raw phases cannot latch the combined mode`, (t) => {
    const { manager, channels } = makeDoublePressHarness(t);
    const listener = installNativeDictationHandlers(manager, platform);

    for (let tap = 0; tap < 2; tap += 1) {
      listener.emit("key-down", "Control+Space");
      t.mock.timers.tick(60);
      listener.emit("key-up", "Control+Space");
      t.mock.timers.tick(120);
    }
    assert.deepEqual(channels(), []);
  });
}

test("losing the exact native listener cancels its pending Hold", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const listener = installNativeDictationHandlers(manager, "linux");
  const hotkey = "Control+Space";
  listener.emit("key-down", hotkey, { exactModifiers: true });
  listener.emit("error", new Error("Listener exited"), hotkey);
  t.mock.timers.tick(250);

  assert.deepEqual(channels(), [
    "prepare-dictation",
    "dictation-force-stopped",
    "cancel-dictation-preparation",
  ]);
});

test("losing an exact native listener stops latched dictation", (t) => {
  const { manager, channels, tap } = makeDoublePressHarness(t);
  const listener = installNativeDictationHandlers(manager, "linux");
  tap();
  tap();
  assert.equal(channels().at(-1), "start-dictation");

  listener.emit("error", new Error("Listener exited"), "Control+Space");

  assert.deepEqual(channels().slice(-2), ["dictation-force-stopped", "stop-dictation"]);
});

test("Linux desktop combined gestures require release from the desktop backend", async (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const listener = installNativeDictationHandlers(manager, "linux");
  manager.hotkeyManager.isUsingNativeShortcut = () => true;
  const desktop = manager.createHotkeyCallback();
  const hotkey = "Control+Space";
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));

  await desktop(hotkey, "down");
  t.mock.timers.tick(60);
  listener.emit("key-up", hotkey);
  assert.deepEqual(channels(), ["prepare-dictation"]);
  await desktop(hotkey, "up");
  assert.deepEqual(channels(), ["prepare-dictation", "cancel-dictation-preparation"]);
});

test("raw extra modifiers invalidate a pending tap and disarm an incomplete stop", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const listener = installNativeDictationHandlers(manager, "win32");
  const hotkey = "Control+Space";
  const emit = (event, key = hotkey) => listener.emit(event, key, { exactModifiers: true });
  const tap = () => {
    emit("key-down");
    t.mock.timers.tick(55);
    emit("key-up");
    t.mock.timers.tick(90);
  };

  tap();
  emit("key-interrupted");
  tap();
  assert.equal(channels().includes("start-dictation"), false);

  emit("key-interrupted", "Alt+Space");
  tap();
  assert.equal(channels().at(-1), "start-dictation");

  emit("key-down");
  emit("key-interrupted");
  emit("key-up");
  assert.equal(channels().includes("stop-dictation"), false);
  tap();
  assert.equal(channels().at(-1), "stop-dictation");
});

function installMacRightModifierHandlers(manager) {
  const modifier = "RightOption";
  const listener = installMacDictationHandlers(manager, modifier);
  return (phase) => listener.emit(`right-modifier-${phase}`, modifier);
}

test("using Right Option in ordinary shortcuts never pairs into a dictation double tap", (t) => {
  const { manager, sent, channels } = makeDoublePressHarness(t);
  const modifier = installMacRightModifierHandlers(manager);

  for (let tap = 0; tap < 2; tap += 1) {
    modifier("down");
    t.mock.timers.tick(25);
    modifier("interrupted");
    t.mock.timers.tick(35);
    modifier("up");
    t.mock.timers.tick(90);
  }
  assert.equal(channels().includes("start-dictation"), false);

  t.mock.timers.tick(400);
  for (let tap = 0; tap < 2; tap += 1) {
    modifier("down");
    t.mock.timers.tick(60);
    modifier("up");
    t.mock.timers.tick(90);
  }
  assert.ok(sent.find(({ channel }) => channel === "start-dictation")?.payload?.handsFreeRequestId);
});

test("an interrupted Right Option press leaves hands-free dictation recording", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const modifier = installMacRightModifierHandlers(manager);
  for (let tap = 0; tap < 2; tap += 1) {
    modifier("down");
    t.mock.timers.tick(60);
    modifier("up");
    t.mock.timers.tick(90);
  }
  assert.equal(channels().at(-1), "start-dictation");

  modifier("down");
  modifier("interrupted");
  modifier("up");
  assert.equal(channels().includes("stop-dictation"), false);

  modifier("down");
  modifier("up");
  assert.equal(channels().at(-1), "stop-dictation");
});

test("releasing Right Option while Left Option is held does not end a compound Hold", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const modifier = installMacRightModifierHandlers(manager);
  manager.startMacCompoundPushToTalk("Alt+Space");
  t.mock.timers.tick(160);

  modifier("up");
  assert.equal(channels().at(-1), "start-dictation");
  manager.handleMacPushModifierUp("option");
  assert.equal(channels().at(-1), "stop-dictation");
});

test("macOS terminal-key taps can latch with the shortcut modifiers held", (t) => {
  const { manager, sent, channels } = makeDoublePressHarness(t);
  for (let tap = 0; tap < 2; tap += 1) {
    manager.startMacCompoundPushToTalk("Control+Shift+Space");
    t.mock.timers.tick(60);
    manager.handleMacCompoundKeyUp("space");
    t.mock.timers.tick(30);
  }
  assert.ok(sent.find(({ channel }) => channel === "start-dictation")?.payload?.handsFreeRequestId);

  manager.startMacCompoundPushToTalk("Control+Shift+Space");
  manager.handleMacCompoundKeyUp("space");
  manager.handleMacPushModifierUp("control");
  assert.equal(channels().includes("stop-dictation"), false);
  manager.handleMacPushModifierUp("shift");
  assert.equal(channels().at(-1), "stop-dictation");
});

test("adding Shift during a macOS compound tap prevents the tap from pairing", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const listener = installMacDictationHandlers(manager, "Control+Space");
  const tap = (extraShift = false) => {
    manager.startMacCompoundPushToTalk("Control+Space");
    t.mock.timers.tick(20);
    if (extraShift) {
      listener.emit("modifier-down", "shift");
      listener.emit("modifier-up", "shift");
    }
    t.mock.timers.tick(40);
    listener.emit("compound-key-up", "space");
    listener.emit("modifier-up", "control");
    t.mock.timers.tick(70);
  };

  tap();
  tap(true);
  assert.equal(channels().includes("start-dictation"), false);
  tap();
  assert.equal(channels().includes("start-dictation"), false);
  tap();
  assert.equal(channels().at(-1), "start-dictation");
});

test("an extra modifier disarms a macOS compound stop gesture", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  const listener = installMacDictationHandlers(manager, "Control+Space");
  for (let i = 0; i < 2; i += 1) {
    manager.startMacCompoundPushToTalk("Control+Space");
    t.mock.timers.tick(60);
    listener.emit("compound-key-up", "space");
    t.mock.timers.tick(70);
  }
  assert.equal(channels().at(-1), "start-dictation");

  manager.startMacCompoundPushToTalk("Control+Space");
  listener.emit("modifier-down", "fn");
  listener.emit("modifier-up", "control");
  assert.equal(channels().includes("stop-dictation"), false);

  manager.startMacCompoundPushToTalk("Control+Space");
  listener.emit("modifier-up", "control");
  assert.equal(channels().at(-1), "stop-dictation");
});

test("modifier presses leave ordinary macOS compound Hold unchanged", (t) => {
  const { manager, channels } = makeDoublePressHarness(t, "push");
  const listener = installMacDictationHandlers(manager, "Control+Space");
  manager.startMacCompoundPushToTalk("Control+Space");
  listener.emit("modifier-down", "shift");
  t.mock.timers.tick(160);
  listener.emit("modifier-up", "control");
  assert.deepEqual(channels(), ["prepare-dictation", "start-dictation", "stop-dictation"]);
});

test("a latched compound shortcut waits for every modifier before stopping", (t) => {
  const { manager, channels } = makeDoublePressHarness(t);
  for (let i = 0; i < 2; i += 1) {
    manager.startMacCompoundPushToTalk("Command+Shift+Space");
    t.mock.timers.tick(70);
    manager.handleMacPushModifierUp("command");
    manager.handleMacPushModifierUp("shift");
    t.mock.timers.tick(120);
  }
  assert.equal(channels().at(-1), "start-dictation");
  manager.startMacCompoundPushToTalk("Command+Shift+Space");
  manager.handleMacPushModifierUp("command");
  assert.equal(channels().includes("stop-dictation"), false);
  manager.handleMacPushModifierUp("shift");
  assert.equal(channels().at(-1), "stop-dictation");
});

test("a declined start releases only its own hands-free latch", (t) => {
  const { manager, sent, channels, tap } = makeDoublePressHarness(t);
  tap();
  tap();
  const firstRequest = sent.at(-1).payload.handsFreeRequestId;
  manager.rejectHandsFreeDictationStart(firstRequest);
  tap();
  assert.equal(channels().at(-1), "cancel-dictation-preparation");
  tap();
  const secondRequest = sent.at(-1).payload.handsFreeRequestId;
  assert.notEqual(secondRequest, firstRequest);
  manager.rejectHandsFreeDictationStart(firstRequest);
  tap();
  assert.equal(channels().at(-1), "stop-dictation");
});

test("switching to Hold stops a latch even while the microphone is opening", async (t) => {
  const { manager, channels, tap } = makeDoublePressHarness(t);
  tap();
  tap();
  manager.hotkeyManager.setActivationMode = async () => true;
  assert.equal(await manager.setActivationModeCache("push"), true);
  assert.deepEqual(channels().slice(-3), [
    "start-dictation",
    "dictation-force-stopped",
    "stop-dictation",
  ]);
});

test("the renderer returning to idle releases the latched binding", (t) => {
  const { manager, channels, tap } = makeDoublePressHarness(t);
  tap();
  tap();
  assert.equal(manager.setDictationLifecycleState("preparing", "hands-free"), true);
  assert.equal(manager.setDictationLifecycleState("recording", "hands-free"), true);
  assert.equal(manager.setDictationLifecycleState("idle", "hands-free"), true);

  tap();
  assert.equal(channels().at(-1), "cancel-dictation-preparation");
  assert.equal(channels().includes("stop-dictation"), false);
});

test("Linux desktop shortcut phases drive the same hands-free gesture", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const { manager, channels } = makeDoublePressHarness(t);
  manager.hotkeyManager.getCurrentHotkey = () => "Control+Space";
  const dispatch = manager.createHotkeyCallback();

  // Electron's press-only registration cannot stand in for the desktop phases.
  await dispatch("Control+Space");
  assert.deepEqual(channels(), []);
  for (let i = 0; i < 2; i += 1) {
    await dispatch(undefined, "down");
    t.mock.timers.tick(70);
    await dispatch(undefined, "up");
    t.mock.timers.tick(120);
  }
  assert.equal(channels().at(-1), "start-dictation");
  await dispatch(undefined, "down");
  assert.equal(channels().includes("stop-dictation"), false);
  await dispatch(undefined, "up");
  assert.equal(channels().at(-1), "stop-dictation");
});

test("combined activation is refused when a registered binding lacks release support", async () => {
  const { manager } = makeManager();
  manager._cachedActivationMode = "push";
  manager.hotkeyManager.getSlotHotkeys = () => ["GLOBE", "F8"];
  manager.hotkeyManager.getDictationDoublePressUnavailableReason = () => "F8 lacks key release";
  manager.hotkeyManager.setActivationMode = async () =>
    assert.fail("unsupported mode reached registration");

  assert.equal(await manager.setActivationModeCache("push-double-tap"), false);
  assert.equal(manager.getActivationMode(), "push");
});

test("selecting Hold plus double-tap uses the native Hold backend", async () => {
  const { manager } = makeManager();
  const registeredModes = [];
  manager.hotkeyManager.setActivationMode = async (mode) => {
    registeredModes.push(mode);
    return true;
  };

  assert.equal(await manager.setActivationModeCache("push-double-tap"), true);
  assert.deepEqual(registeredModes, ["push"]);
  assert.equal(manager.getActivationMode(), "push-double-tap");
});
