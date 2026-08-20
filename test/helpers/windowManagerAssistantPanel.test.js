const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Same stub set as windowManagerMeetingNotification.test.js: WindowManager
// pulls in electron + sibling managers at require time.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: { getPrimaryDisplay: () => ({}), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
      BrowserWindow: class {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./debugLogger") return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class { unregisterAll() {} isInListeningMode() { return false; } };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./dragManager") return class { cleanup() {} async startWindowDrag() { return { success: true }; } async stopWindowDrag() { return { success: true }; } };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") return { DEV_SERVER_PORT: 5173, DEV_SERVER_URL: "http://localhost:5173", getAppFilePath: () => ({ path: "/app/index.html", query: {} }), waitForDevServer: async () => undefined };
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
      WindowPositionUtil: { setupAlwaysOnTop: () => undefined, clampToWorkArea: (b) => b, getMainWindowPosition: () => ({ x: 0, y: 0 }), getNotificationPosition: () => ({ x: 0, y: 0 }) },
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

function fakeWindow({ visible }) {
  const calls = [];
  let isVisible = visible;
  return {
    calls,
    window: {
      isDestroyed: () => false,
      isVisible: () => isVisible,
      isMinimized: () => false,
      showInactive: () => { isVisible = true; calls.push("showInactive"); },
      show: () => { isVisible = true; calls.push("show"); },
      hide: () => { isVisible = false; calls.push("hide"); },
      focus: () => calls.push("focus"),
      blur: () => calls.push("blur"),
      setFocusable: (value) => calls.push(`focusable:${value}`),
      setContentProtection: () => undefined,
      getBounds: () => ({ x: 0, y: 0, width: 96, height: 96 }),
    },
  };
}

function makeManager(windowState) {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  const fake = fakeWindow(windowState);
  manager.mainWindow = fake.window;
  manager.enforceMainWindowOnTop = () => undefined;
  manager._notifyMainWindowHorizontalDirection = () => undefined;
  return { manager, calls: fake.calls };
}

test("opening the assistant panel surfaces a hidden pill window before focusing it", () => {
  const { manager, calls } = makeManager({ visible: false });
  manager.setAssistantPanelOpen(true);
  assert.deepEqual(calls, ["showInactive", "focusable:true", "focus"]);
});

test("showDictationPanel still surfaces a hidden window while the panel is open", () => {
  const { manager, calls } = makeManager({ visible: false });
  // Panel open but the window got hidden afterwards (tray Hide raced the open).
  manager._assistantPanelOpen = true;
  manager.showDictationPanel({ focus: true });
  assert.deepEqual(calls, ["showInactive", "focus"]);
});

test("hideDictationPanel refuses while an assistant command is busy or the panel is open", () => {
  const { manager, calls } = makeManager({ visible: true });
  manager.setAssistantPanelBusy(true);
  manager.hideDictationPanel();
  assert.deepEqual(calls, [], "a thinking command must not lose its window");
  manager.setAssistantPanelBusy(false);
  manager.setAssistantPanelOpen(true);
  calls.length = 0;
  manager.hideDictationPanel();
  assert.deepEqual(calls, []);
  manager.setAssistantPanelOpen(false);
  calls.length = 0;
  manager.hideDictationPanel();
  assert.deepEqual(calls, ["hide"]);
});

test("compact onboarding stays fixed-size but remains minimizable and closable", () => {
  const manager = new WindowManager();
  const state = {};
  const win = {
    getBounds: () => ({ x: 0, y: 0, width: 480, height: 624 }),
    setResizable: (value) => {
      state.resizable = value;
    },
    setMinimizable: (value) => {
      state.minimizable = value;
    },
    setMaximizable: (value) => {
      state.maximizable = value;
    },
    setClosable: (value) => {
      state.closable = value;
    },
    setFullScreenable: (value) => {
      state.fullScreenable = value;
    },
    setMinimumSize: (width, height) => {
      state.minimumSize = { width, height };
    },
    setWindowButtonVisibility: () => undefined,
  };

  manager._applyOnboardingWindowChrome(win, "compact");

  assert.deepEqual(state, {
    resizable: false,
    minimizable: true,
    maximizable: false,
    closable: true,
    fullScreenable: false,
    minimumSize: { width: 480, height: 624 },
  });
});

test("native Linux push-to-talk keeps only the dictation low-level listener", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  try {
    const manager = new WindowManager();
    let reconciledKeys = null;
    manager.mainWindow = { isDestroyed: () => false };
    manager.setActivationModeCache("push");
    manager.hotkeyManager = {
      isInListeningMode: () => false,
      isUsingNativeShortcut: () => true,
      getNativeListenerKeys: () => ["Control+Space", "Control+Shift+Space"],
      slotHasHotkey: (slot, key) => slot === "dictation" && key === "Control+Space",
    };
    manager.linuxKeyManager = {
      setKeys: (keys) => {
        reconciledKeys = keys;
      },
    };

    manager.reconcileNativeKeyListeners();

    assert.deepEqual(reconciledKeys, ["Control+Space"]);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("a zero-movement click does not mark the pill as manually positioned", async () => {
  const { manager } = makeManager({ visible: true });
  await manager.startWindowDrag();
  await manager.stopWindowDrag();
  assert.equal(manager._mainWindowPlacementCoordinator._hasManualPosition, false);
});

test("a real drag marks the pill as manually positioned", async () => {
  const { manager } = makeManager({ visible: true });
  let bounds = { x: 0, y: 0, width: 96, height: 96 };
  manager.mainWindow.getBounds = () => bounds;
  await manager.startWindowDrag();
  bounds = { x: 120, y: 40, width: 96, height: 96 };
  await manager.stopWindowDrag();
  assert.equal(manager._mainWindowPlacementCoordinator._hasManualPosition, true);
});
