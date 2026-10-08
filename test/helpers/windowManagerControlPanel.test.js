const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const dockVisibilityCalls = [];

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({}),
        getDisplayMatching: () => ({
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
        }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
        }),
      },
      BrowserWindow: class {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") {
    return {
      warn: () => undefined,
      debug: () => undefined,
      log: () => undefined,
    };
  }
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
  if (request === "./dragManager") {
    return class {
      cleanup() {}
    };
  }
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  }
  if (request === "./dockManager") {
    return {
      setControlPanelVisible: (visible) => dockVisibilityCalls.push(visible),
    };
  }
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
        getMainWindowPosition: () => ({ x: 0, y: 0 }),
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

function createControlPanelWindow({
  visible,
  bounds = { x: 120, y: 90, width: 1200, height: 800 },
}) {
  const calls = [];
  let currentBounds = { ...bounds };
  let isVisible = visible;

  return {
    calls,
    isVisible: () => isVisible,
    window: {
      isDestroyed: () => false,
      isVisible: () => isVisible,
      isFullScreen: () => false,
      isMaximized: () => false,
      getBounds: () => ({ ...currentBounds }),
      getContentBounds: () => ({ ...currentBounds }),
      setContentBounds: (nextBounds) => {
        currentBounds = { ...nextBounds };
        calls.push("setContentBounds");
      },
      isResizable: () => true,
      isMinimizable: () => true,
      isMaximizable: () => true,
      isClosable: () => true,
      isFullScreenable: () => true,
      getMinimumSize: () => [400, 300],
      setResizable: () => undefined,
      setMinimizable: () => undefined,
      setMaximizable: () => undefined,
      setClosable: () => undefined,
      setFullScreenable: () => undefined,
      setMinimumSize: () => undefined,
      setWindowButtonVisibility: () => undefined,
      show: () => {
        isVisible = true;
        calls.push("show");
      },
      focus: () => calls.push("focus"),
      hide: () => {
        isVisible = false;
        calls.push("hide");
      },
    },
  };
}

function createManager(windowOptions) {
  const manager = new WindowManager();
  const fake = createControlPanelWindow(windowOptions);
  manager.controlPanelWindow = fake.window;
  manager._clearControlPanelVisibilityTimer = () => {
    manager._controlPanelVisibilityTimer = null;
    fake.calls.push("clearVisibilityTimer");
  };
  return { manager, ...fake };
}

test.beforeEach(() => {
  dockVisibilityCalls.length = 0;
});

test("initial restore still reveals the renderer-sized control panel", () => {
  const { manager, calls, isVisible } = createManager({ visible: false });
  manager._controlPanelVisibilityTimer = 1;

  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.equal(isVisible(), true);
  assert.deepEqual(calls, ["clearVisibilityTimer", "show", "focus"]);
  assert.deepEqual(dockVisibilityCalls, [true]);
});

test("repeated restore preserves a control panel hidden to the tray", () => {
  const { manager, calls, isVisible } = createManager({ visible: true });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);
});

test("compact reauthentication can resize a tray-hidden panel without surfacing it", () => {
  const { manager, calls, isVisible } = createManager({ visible: true });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  assert.equal(manager.setOnboardingWindowMode("compact"), true);

  assert.equal(isVisible(), false);
  assert.deepEqual(calls, ["setContentBounds"]);
  assert.deepEqual(dockVisibilityCalls, []);
});
