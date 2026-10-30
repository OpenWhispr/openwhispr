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
      screen: {
        getPrimaryDisplay: () => ({}),
        getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
        on: () => undefined,
      },
      BrowserWindow: class FakeBrowserWindow {
        constructor(options) {
          this.options = options;
          this.protectionCalls = [];
          this.closeCalls = 0;
          this.setBoundsCalls = 0;
          this.visible = false;
          this.bounds = { x: 0, y: 0, width: 0, height: 0 };
          this.windowListeners = new Map();
          this.sent = [];
          this.webContentsListeners = new Map();
          this.webContents = {
            on: (event, listener) => this.webContentsListeners.set(event, listener),
            send: (channel, payload) => this.sent.push({ channel, payload }),
          };
        }
        on(event, listener) {
          this.windowListeners.set(event, listener);
        }
        setContentProtection(value) {
          this.protectionCalls.push(value);
        }
        setIgnoreMouseEvents() {}
        loadFile() {
          return Promise.resolve();
        }
        loadURL() {
          return Promise.resolve();
        }
        isDestroyed() {
          return false;
        }
        close() {
          this.closeCalls += 1;
          this.windowListeners.get("closed")?.();
        }
        getBounds() {
          return this.bounds;
        }
        setBounds(nextBounds) {
          this.bounds = nextBounds;
          this.setBoundsCalls += 1;
        }
        isVisible() {
          return this.visible;
        }
        showInactive() {
          this.visible = true;
        }
        hide() {
          this.visible = false;
        }
        moveTop() {}
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
      async startWindowDrag() {
        return { success: true };
      }
      async stopWindowDrag() {
        return { success: true };
      }
    };
  if (request === "./menuManager") return {};
  if (request === "./devServerManager")
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppUrl: () => null,
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: async () => undefined,
    };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./linuxWindowInputRegion") {
    return {
      createLinuxWindowInputRegion: () => ({
        focus: async () => undefined,
        stop: () => undefined,
      }),
    };
  }
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: (_display, size) => ({ x: 0, y: 0, ...size }),
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

function fakeWindow({ visible, focused = false }) {
  const calls = [];
  let isVisible = visible;
  let isFocused = focused;
  return {
    calls,
    window: {
      isDestroyed: () => false,
      isVisible: () => isVisible,
      isMinimized: () => false,
      showInactive: () => {
        isVisible = true;
        calls.push("showInactive");
      },
      show: () => {
        isVisible = true;
        calls.push("show");
      },
      hide: () => {
        isVisible = false;
        calls.push("hide");
      },
      focus: () => calls.push("focus"),
      // Like Electron, blur() clears the flag even where X focus stays put.
      blur: () => {
        isFocused = false;
        calls.push("blur");
      },
      isFocused: () => isFocused,
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

// Assistant replies can carry links an injected prompt chose, so an overlay
// window hands them to the browser like the control panel instead of opening
// an in-app window, and never passes a local path to the OS.
test("overlay links open in the browser, never an in-app window or a local file", () => {
  const manager = new WindowManager();
  const opened = [];
  manager.openExternalUrl = (url) => opened.push(url);
  const listeners = new Map();
  let openHandler;
  const window = {
    webContents: {
      on: (event, listener) => listeners.set(event, listener),
      setWindowOpenHandler: (handler) => {
        openHandler = handler;
      },
    },
  };

  manager.registerExternalLinkHandlers(window, false);

  for (const url of [
    "https://attacker.example/chart.png",
    "mailto:someone@example.com",
    "file:///C:/Windows/System32/cmd.exe",
    "javascript:alert(1)",
  ]) {
    assert.deepEqual(openHandler({ url }), { action: "deny" });
  }
  assert.deepEqual(opened, ["https://attacker.example/chart.png", "mailto:someone@example.com"]);

  opened.length = 0;
  let prevented = 0;
  const event = { preventDefault: () => (prevented += 1) };
  listeners.get("will-navigate")(event, "file:///app/index.html?panel=false");
  listeners.get("will-navigate")(event, "https://attacker.example/");
  listeners.get("will-navigate")(event, "file:///C:/Windows/System32/cmd.exe");
  assert.equal(prevented, 2, "only the app's own reload may navigate the window");
  assert.deepEqual(opened, ["https://attacker.example/"]);
});

test("live transcript updates do not restack an already visible dictation window", async () => {
  const manager = new WindowManager();
  const calls = [];
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive: () => calls.push("showInactive"),
    webContents: { send: () => undefined },
  };
  manager.enforceMainWindowOnTop = () => calls.push("onTop");

  await manager.showTranscriptionPreview("one");
  await manager.showTranscriptionPreview("two");

  assert.deepEqual(calls, []);
});

test("the first live transcript update still surfaces a hidden dictation window", async () => {
  const manager = new WindowManager();
  const calls = [];
  manager.setOnboardingActive(false);
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => false,
    showInactive: () => calls.push("showInactive"),
    webContents: { send: () => undefined },
  };
  manager.enforceMainWindowOnTop = () => calls.push("onTop");

  await manager.showTranscriptionPreview("hello");

  assert.deepEqual(calls, ["showInactive", "onTop"]);
});

test("compact onboarding exposes the complete window-control contract", () => {
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
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    fullScreenable: false,
    minimumSize: { width: 480, height: 624 },
  });
});

test("compact macOS onboarding shows the native traffic lights", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  try {
    const manager = new WindowManager();
    let buttonsVisible = false;
    const win = {
      getBounds: () => ({ x: 0, y: 0, width: 480, height: 624 }),
      setResizable: () => undefined,
      setMinimizable: () => undefined,
      setMaximizable: () => undefined,
      setClosable: () => undefined,
      setFullScreenable: () => undefined,
      setMinimumSize: () => undefined,
      setWindowButtonVisibility: (visible) => {
        buttonsVisible = visible;
      },
    };

    manager._applyOnboardingWindowChrome(win, "compact");

    assert.equal(buttonsVisible, true);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("native Linux push-to-talk keeps only the dictation low-level listener", async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  try {
    const manager = new WindowManager();
    let reconciledKeys = null;
    manager.mainWindow = { isDestroyed: () => false };
    manager.hotkeyManager = {
      setActivationMode: async () => true,
      isInListeningMode: () => false,
      isUsingNativeShortcut: () => true,
      getNativeListenerKeys: () => ["Control+Space", "Control+Shift+Space"],
      slotHasHotkey: (slot, key) => slot === "dictation" && key === "Control+Space",
    };
    await manager.setActivationModeCache("push");
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

test("prepare-dictation goes out only for a press the onboarding demo allows", () => {
  const manager = new WindowManager();
  manager.hotkeyManager = { isInListeningMode: () => false };
  const sent = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    showInactive: () => undefined,
    hide: () => undefined,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  manager.beginOnboardingDemo("assistant");
  sent.length = 0;

  manager.sendPrepareDictation();
  manager.sendPrepareDictation({ inputKind: "assistant" });

  assert.deepEqual(sent, [{ channel: "prepare-dictation", payload: undefined }]);
});

// The normal app: onboarding is over.
function normalWindowManager() {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  return manager;
}

// The tray's (and the pill menu's) Ask assistant opens the agent window to its
// composer; the dictation pill is neither shown nor focused for it.
test("Ask assistant opens the agent window, never the dictation pill", () => {
  const events = [];
  const manager = normalWindowManager();
  manager.mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    focus: () => events.push("focus"),
    show: () => events.push("show"),
    showInactive: () => events.push("show"),
    webContents: { send: (channel) => events.push(channel) },
  };
  manager.agentWindow = { open: (options) => events.push(["agent", options]) };
  manager.openAgentWindow();
  assert.deepEqual(events, [["agent", { layout: "typing" }]]);
});

// Every voice-assistant press ends in sendToggleVoiceAgent: during onboarding
// it records in the dictation window for the assistant demo, and otherwise it
// is the agent window's.
test("agent hotkey presses reach the agent window, except onboarding's demo", () => {
  const events = [];
  const fakeMainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    showInactive: () => undefined,
    hide: () => undefined,
    webContents: { send: (channel) => events.push(["main", channel]) },
  };
  const agentWindow = {
    handleHotkey: () => events.push(["agent", "hotkey"]),
    isRecording: () => false,
  };

  const onboarding = new WindowManager();
  onboarding.mainWindow = fakeMainWindow;
  onboarding.agentWindow = agentWindow;
  onboarding.beginOnboardingDemo("assistant");
  events.length = 0;
  onboarding.sendToggleVoiceAgent();
  assert.deepEqual(events, [
    ["main", "prepare-dictation"],
    ["main", "toggle-voice-agent"],
  ]);

  events.length = 0;
  const manager = normalWindowManager();
  manager.mainWindow = fakeMainWindow;
  manager.agentWindow = agentWindow;
  manager.sendToggleVoiceAgent();
  assert.deepEqual(events, [["agent", "hotkey"]]);
});

test("while the agent window records, every dictation press is held off", () => {
  const sent = [];
  const userRecording = [];
  const manager = normalWindowManager();
  manager.mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    showInactive: () => undefined,
    webContents: { send: (channel) => sent.push(channel) },
  };
  manager.meetingDetectionEngine = { setUserRecording: (value) => userRecording.push(value) };
  manager.showDictationPanel = () => undefined;
  let agentRecording = true;
  manager.agentWindow = { isRecording: () => agentRecording };

  manager.sendToggleDictation();
  manager.sendToggleTranslation();
  manager.sendStartDictation();
  assert.deepEqual(sent, []);

  manager.syncUserRecording();
  agentRecording = false;
  manager.syncUserRecording();
  assert.deepEqual(userRecording, [true, false]);
  manager.sendToggleDictation();
  assert.ok(sent.includes("toggle-dictation"));
});
