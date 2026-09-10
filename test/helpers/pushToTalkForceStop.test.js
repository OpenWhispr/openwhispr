const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

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
      AUTO_END_NOTIFICATION_WINDOW_SIZE: { width: 620, height: 116 },
      getMeetingNotificationWindowSize: () => ({ width: 392, height: 92 }),
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
Module._load = originalLoad;

// Returns the manager plus the channels it pushed to the renderer, in order.
function makeManager() {
  const sent = [];
  const manager = new WindowManager();
  manager.hotkeyManager = { isInListeningMode: () => false };
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
