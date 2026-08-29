const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const requestedMainWindowPositions = [];
const createdBrowserWindows = [];
const screenListeners = [];

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
        on: (event, listener) => screenListeners.push({ event, listener }),
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
          createdBrowserWindows.push(this);
        }
        on(event, listener) { this.windowListeners.set(event, listener); }
        setContentProtection(value) { this.protectionCalls.push(value); }
        setIgnoreMouseEvents() {}
        loadFile() { return Promise.resolve(); }
        loadURL() { return Promise.resolve(); }
        isDestroyed() { return false; }
        close() { this.closeCalls += 1; this.windowListeners.get("closed")?.(); }
        getBounds() { return this.bounds; }
        setBounds(nextBounds) { this.bounds = nextBounds; this.setBoundsCalls += 1; }
        isVisible() { return this.visible; }
        showInactive() { this.visible = true; }
        hide() { this.visible = false; }
        moveTop() {}
      },
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
      WindowPositionUtil: {
        setupAlwaysOnTop: () => undefined,
        clampToWorkArea: (b) => b,
        getMainWindowPosition: (_display, size, position) => {
          requestedMainWindowPositions.push(position);
          return { x: 0, y: 0, ...size };
        },
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
  manager.showAgentDictationPill = () => undefined;
  manager.hideAgentDictationPill = () => undefined;
  return { manager, calls: fake.calls };
}

test("the Agent companion follows the edge opposite the panel", () => {
  requestedMainWindowPositions.length = 0;
  const manager = new WindowManager();
  const positions = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    setBounds: (bounds) => positions.push(bounds),
  };

  manager.positionAgentDictationPill();

  assert.deepEqual(positions, [{ x: 0, y: 0, width: 96, height: 96 }]);
  assert.deepEqual(requestedMainWindowPositions, ["bottom-left"]);
});

test("the companion grows for Live Transcript and returns to its pill footprint", () => {
  const manager = new WindowManager();
  let bounds = { x: 0, y: 0, width: 96, height: 96 };
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    getBounds: () => bounds,
    setBounds: (nextBounds) => {
      bounds = nextBounds;
    },
  };

  const expanded = manager.resizeAgentDictationPillToContent(240);
  const collapsed = manager.resizeAgentDictationPillToContent(null);

  assert.equal(expanded.success, true);
  assert.deepEqual(expanded.bounds, { x: 0, y: 0, width: 466, height: 240 });
  assert.equal(collapsed.success, true);
  assert.deepEqual(collapsed.bounds, { x: 0, y: 0, width: 96, height: 96 });
});

test("the Agent companion ignores Agent voice lifecycle and mirrors plain dictation", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager.setDictationLifecycleState("recording", "assistant");
  manager.setDictationLifecycleState("recording", "dictation");

  assert.deepEqual(messages, [
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "idle", interactive: false, horizontalDirection: "left" },
    },
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "recording", interactive: true, horizontalDirection: "left" },
    },
  ]);
});

test("the companion receives live audio levels only for ordinary dictation", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._assistantPanelOpen = true;
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager.setDictationLifecycleState("recording", "dictation");
  messages.length = 0;
  manager.setDictationAudioLevel(0.42);
  manager.setDictationLifecycleState("recording", "assistant");
  manager.setDictationAudioLevel(0.9);

  assert.deepEqual(messages, [
    { channel: "agent-dictation-pill-audio-level-changed", payload: 0.42 },
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "idle", interactive: false, horizontalDirection: "left" },
    },
  ]);
});

test("the companion toggles macOS click-through with hover interactivity", () => {
  const manager = new WindowManager();
  const ignoreCalls = [];
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    setIgnoreMouseEvents: (ignore, opts) => ignoreCalls.push({ ignore, opts }),
  };

  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    manager.setAgentDictationPillInteractivity(true);
    manager.setAgentDictationPillInteractivity(false);
    // Windows/Linux keep normal hit-testing (forward is unreliable/ignored).
    Object.defineProperty(process, "platform", { value: "linux" });
    manager.setAgentDictationPillInteractivity(false);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }

  assert.deepEqual(ignoreCalls, [
    { ignore: false, opts: undefined },
    { ignore: true, opts: { forward: true } },
  ]);
});

test("the Agent companion window is created content-protected", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();

  assert.equal(createdBrowserWindows.length, 1);
  assert.deepEqual(createdBrowserWindows[0].protectionCalls, [true]);
});

test("the companion cancel control routes through the dictation renderer", () => {
  const manager = new WindowManager();
  const channels = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel) => channels.push(channel) },
  };

  manager.sendCancelActiveDictation();

  assert.deepEqual(channels, ["cancel-dictation"]);
});

test("live transcript events are mirrored to the companion only for plain dictation", async () => {
  const manager = new WindowManager();
  const mainMessages = [];
  const companionMessages = [];
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager._agentDictationPillReady = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    showInactive: () => undefined,
    webContents: { send: (channel, payload) => mainMessages.push({ channel, payload }) },
  };
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => companionMessages.push({ channel, payload }),
    },
  };
  manager.enforceMainWindowOnTop = () => undefined;

  manager._dictationInputKind = "assistant";
  await manager.showTranscriptionPreview("agent");
  manager._dictationInputKind = "dictation";
  await manager.showTranscriptionPreview("plain");

  assert.deepEqual(mainMessages, [
    { channel: "preview-text", payload: "agent" },
    { channel: "preview-text", payload: "plain" },
  ]);
  assert.deepEqual(companionMessages, [{ channel: "preview-text", payload: "plain" }]);
});

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

test("did-finish-load marks the companion ready, pushes state, and shows it", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  assert.equal(manager._agentDictationPillReady, false);

  pill.webContentsListeners.get("did-finish-load")();

  assert.equal(manager._agentDictationPillReady, true);
  assert.deepEqual(pill.sent, [
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "idle", interactive: true, horizontalDirection: "left" },
    },
  ]);
  assert.equal(pill.visible, true);
});

test("a crashed companion renderer drops readiness and closes for recreation", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(manager._agentDictationPillReady, true);

  pill.webContentsListeners.get("render-process-gone")(null, { reason: "crashed" });

  assert.equal(manager._agentDictationPillReady, false);
  assert.equal(pill.closeCalls, 1);
  assert.equal(manager.agentDictationPillWindow, null);
  assert.equal(manager._isAgentDictationPillAvailable(), false);
});

test("a clean-exit companion renderer teardown leaves readiness untouched", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(manager._agentDictationPillReady, true);

  pill.webContentsListeners.get("render-process-gone")(null, { reason: "clean-exit" });

  assert.equal(manager._agentDictationPillReady, true);
  assert.equal(pill.closeCalls, 0);
  assert.equal(manager.agentDictationPillWindow, pill);
});

test("prepare-dictation carries the toggle's input kind to the renderer", () => {
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager.hotkeyManager = { isInListeningMode: () => false };
  const sent = [];
  manager.mainWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };

  manager.sendPrepareDictation({ inputKind: "assistant" });
  manager.sendPrepareDictation();

  assert.deepEqual(sent, [
    { channel: "prepare-dictation", payload: { inputKind: "assistant" } },
    { channel: "prepare-dictation", payload: { inputKind: "dictation" } },
  ]);
});

test("mic preparation reaches the companion as its own lifecycle", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager.setDictationLifecycleState("preparing", "dictation");

  assert.deepEqual(messages, [
    {
      channel: "agent-dictation-pill-state-changed",
      payload: { lifecycle: "preparing", interactive: true, horizontalDirection: "left" },
    },
  ]);
});

test("error-recovery transcripts mirror to the companion only for plain dictation", () => {
  const manager = new WindowManager();
  const messages = [];
  manager._assistantPanelOpen = true;
  manager._agentDictationPillReady = true;
  manager.agentDictationPillWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
  };

  manager._dictationInputKind = "assistant";
  manager.showAgentDictationFinalTranscript("agent");
  manager._dictationInputKind = "dictation";
  manager.showAgentDictationFinalTranscript("plain");

  assert.deepEqual(messages, [
    { channel: "agent-dictation-pill-final-transcript", payload: "plain" },
  ]);
});

test("display changes reposition the companion pill", () => {
  createdBrowserWindows.length = 0;
  screenListeners.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows[0];
  pill.webContentsListeners.get("did-finish-load")();
  const boundsCallsBefore = pill.setBoundsCalls;

  const metricsListener = screenListeners.find((entry) => entry.event === "display-metrics-changed");
  assert.ok(metricsListener, "display-metrics-changed listener registered");
  metricsListener.listener();

  assert.equal(pill.setBoundsCalls, boundsCallsBefore + 1);
  assert.deepEqual(
    screenListeners.map((entry) => entry.event).sort(),
    ["display-added", "display-metrics-changed", "display-removed"]
  );
});

test("onboarding suppresses the companion pill like every popup surface", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(true);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();

  assert.equal(createdBrowserWindows.length, 0);
});

test("a ready but hidden companion never counts as an available surface", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows.at(-1);
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(pill.isVisible(), true);
  assert.equal(manager._shouldBlockDictationInput("dictation"), false);

  // Onboarding hides the pill without dropping readiness; a hidden surface
  // cannot show a recording, so dictation must fail closed rather than start
  // invisibly.
  manager.hideAgentDictationPill();
  assert.equal(pill.isVisible(), false);
  assert.equal(manager._shouldBlockDictationInput("dictation"), true);
  // The blocked press re-kicks the show, so the next press can land.
  assert.equal(pill.isVisible(), true);
});

test("entering onboarding hides an already-visible companion pill", () => {
  createdBrowserWindows.length = 0;
  const manager = new WindowManager();
  manager.setOnboardingActive(false);
  manager._assistantPanelOpen = true;
  manager.mainWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ x: 1000, y: 100, width: 400, height: 600 }),
    // Entering onboarding cancels any in-flight dictation before it hides
    // the normal-app surfaces.
    webContents: { send: () => undefined },
  };

  manager.showAgentDictationPill();
  const pill = createdBrowserWindows.at(-1);
  pill.webContentsListeners.get("did-finish-load")();
  assert.equal(pill.isVisible(), true);

  manager.setOnboardingActive(true);

  assert.equal(pill.isVisible(), false);
});
