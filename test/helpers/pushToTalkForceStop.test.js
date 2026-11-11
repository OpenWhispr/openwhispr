const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
