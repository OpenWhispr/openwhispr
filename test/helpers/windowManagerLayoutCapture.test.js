const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Same stubs as pushToTalkForceStop.test.js: WindowManager pulls in electron and
// sibling managers at require time.
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
Module._load = originalLoad;

// `calls` records the order of the layout capture and the panel show, which is
// what matters: once the overlay is shown it owns the foreground window.
function makeManager({ captureEnabled = true } = {}) {
  const calls = [];
  const manager = new WindowManager();
  manager.hotkeyManager = {
    isInListeningMode: () => false,
    logHotkeyEvent: () => undefined,
  };
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => calls.push(`send:${channel}`) },
  };
  manager.showDictationPanel = () => calls.push("showDictationPanel");
  manager.isDictationProcessing = () => false;
  manager.setLayoutProbe({ capture: () => calls.push("capture") });
  manager.setLayoutCaptureEnabled(captureEnabled);
  return { manager, calls };
}

test("startWindowsPushToTalk captures layout before showing the dictation panel", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { manager, calls } = makeManager();
  manager.startWindowsPushToTalk("Control+Space");

  assert.deepEqual(calls.slice(0, 2), ["capture", "showDictationPanel"]);
  assert.equal(calls.filter((c) => c === "capture").length, 1);
});

test("the delayed start-dictation of a push does not capture again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { manager, calls } = makeManager();
  manager.startWindowsPushToTalk("Control+Space");
  t.mock.timers.tick(150);

  assert.equal(calls.filter((c) => c === "capture").length, 1);
  assert.ok(calls.includes("send:start-dictation"));
});

test("toggle press captures layout before showing the dictation panel", () => {
  const { manager, calls } = makeManager();
  manager.sendToggleDictation();

  assert.deepEqual(calls.slice(0, 2), ["capture", "showDictationPanel"]);
  assert.ok(calls.includes("send:toggle-dictation"));
});

test("no capture when preferredLanguage is not 'keyboard'", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());

  const { manager, calls } = makeManager({ captureEnabled: false });
  manager.startWindowsPushToTalk("Control+Space");
  manager.sendToggleDictation();

  assert.equal(calls.includes("capture"), false);
  assert.ok(calls.includes("showDictationPanel"));
});
