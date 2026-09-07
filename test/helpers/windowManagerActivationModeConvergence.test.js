const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Same stub set as windowManagerHandsFree.test.js: WindowManager pulls in
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

function managerWithHotkeyResult(result) {
  const manager = new WindowManager();
  manager.mainWindow = null;
  manager.hotkeyManager = {
    updateHotkey: async () => result,
    isInListeningMode: () => false,
    getNativeListenerKeys: () => [],
    isUsingNativeShortcut: () => false,
  };
  manager.createHotkeyCallback = () => () => undefined;
  manager.resetNativePushState = () => undefined;
  manager.reconcileNativeKeyListeners = () => undefined;
  return manager;
}

test("updateHotkey follows a converged mode in both directions", async () => {
  const demoted = managerWithHotkeyResult({ success: true, activationMode: "tap" });
  demoted._cachedActivationMode = "push";
  await demoted.updateHotkey("F13");
  assert.equal(demoted.getActivationMode(), "tap");

  const promoted = managerWithHotkeyResult({ success: true, activationMode: "push" });
  promoted._cachedActivationMode = "tap";
  await promoted.updateHotkey("Command+Period");
  assert.equal(promoted.getActivationMode(), "push");

  const untouched = managerWithHotkeyResult({ success: true });
  untouched._cachedActivationMode = "tap";
  await untouched.updateHotkey("Command+Period");
  assert.equal(untouched.getActivationMode(), "tap");
});
