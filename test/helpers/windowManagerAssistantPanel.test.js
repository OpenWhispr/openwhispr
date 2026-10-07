const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const requestedMainWindowPositions = [];
const createdBrowserWindows = [];
const screenListeners = [];
const builtMenus = [];
// What the macOS Spaces helper answers. WindowManager must show the window
// either way, so a test can make it fail.
let spacesReassertResult = true;

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
          this.calls = [];
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
          this.calls.push("showInactive");
        }
        hide() {
          this.visible = false;
          this.calls.push("hide");
        }
        moveTop() {
          this.calls.push("moveTop");
        }
      },
      Menu: {
        buildFromTemplate: (template) => {
          const menu = {
            popupCalls: [],
            popup(options) {
              this.popupCalls.push(options);
            },
          };
          builtMenus.push({ template, menu });
          return menu;
        },
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
      isDragActive() {
        return false;
      }
      async startWindowDrag() {
        return { success: true };
      }
      async stopWindowDrag() {
        return { success: true };
      }
    };
  if (request === "./menuManager") return {};
  // Records into the window's own call log, so each test reads the re-assert's
  // place among that window's show/hide/restore calls.
  if (request === "./macosWindowSpaces")
    return {
      reassertAllSpaces: (win) => {
        win.calls?.push("reassertAllSpaces");
        return spacesReassertResult;
      },
    };
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

function fakeWindow({ visible, minimized = false }) {
  const calls = [];
  const listeners = new Map();
  let isVisible = visible;
  let isMinimized = minimized;
  return {
    calls,
    listeners,
    window: {
      calls,
      on: (event, listener) => listeners.set(event, listener),
      once: (event, listener) => listeners.set(event, listener),
      webContents: { send: () => undefined },
      isDestroyed: () => false,
      isVisible: () => isVisible,
      isMinimized: () => isMinimized,
      restore: () => {
        isMinimized = false;
        isVisible = true;
        calls.push("restore");
      },
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
  return { manager, calls: fake.calls, listeners: fake.listeners };
}

const countCalls = (calls, name) => calls.filter((call) => call === name).length;

// The re-assert must reach a still-hidden window: once ordered in, a window
// macOS pinned to one Space is already on the wrong desktop.
function assertReassertedOnceBefore(calls, orderIn) {
  assert.equal(countCalls(calls, "reassertAllSpaces"), 1, JSON.stringify(calls));
  assert.ok(calls.includes(orderIn), `${orderIn} missing from ${JSON.stringify(calls)}`);
  assert.ok(calls.indexOf("reassertAllSpaces") < calls.indexOf(orderIn), JSON.stringify(calls));
}

test("the Assistant response context menu exposes native Copy only for selected text", () => {
  builtMenus.length = 0;
  const manager = new WindowManager();
  const listeners = new Map();
  manager.mainWindow = {
    webContents: { on: (event, listener) => listeners.set(event, listener) },
  };
  manager._assistantPanelOpen = true;
  manager.registerAssistantSelectionContextMenu();

  const onContextMenu = listeners.get("context-menu");
  assert.ok(onContextMenu);
  onContextMenu(null, { selectionText: "selected answer" });
  onContextMenu(null, { selectionText: "   " });

  assert.equal(builtMenus.length, 1);
  assert.deepEqual(builtMenus[0].template, [{ role: "copy" }]);
  assert.deepEqual(builtMenus[0].menu.popupCalls, [{ window: manager.mainWindow }]);

  manager._assistantPanelOpen = false;
  onContextMenu(null, { selectionText: "outside Assistant" });
  assert.equal(builtMenus.length, 1);
});

// Assistant replies can carry links an injected prompt chose, so the dictation
// window hands them to the browser like the control panel instead of opening
// an in-app window, and never passes a local path to the OS.
test("assistant panel links open in the browser, never an in-app window or a local file", () => {
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
    isVisible: () => true,
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

// Both platform paths run on every runner: branching the expectation on the
// host's own process.platform would leave whichever path CI is not running
// unverified — and darwin is the one that carries the contract.
function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("opening the assistant panel surfaces a hidden pill window without activating on macOS", () => {
  withPlatform("darwin", () => {
    const { manager, calls } = makeManager({ visible: false });
    manager.setAssistantPanelOpen(true);
    // focus() answers a user-granted activation with a whole-desktop Space
    // slide when another OpenWhispr window lives on a different Space. The
    // non-activating panel becomes key on click instead.
    assert.deepEqual(calls, ["reassertAllSpaces", "showInactive", "focusable:true"]);
  });
});

test("opening the assistant panel focuses the pill window on Windows/Linux", () => {
  for (const platform of ["win32", "linux"]) {
    withPlatform(platform, () => {
      const { manager, calls } = makeManager({ visible: false });
      manager.setAssistantPanelOpen(true);
      // The Spaces re-assert is asked for everywhere; the helper is a no-op
      // off macOS.
      assert.deepEqual(
        calls,
        ["reassertAllSpaces", "showInactive", "focusable:true", "focus"],
        platform
      );
    });
  }
});

test("closing the assistant panel blurs only where opening focused", () => {
  withPlatform("darwin", () => {
    const { manager, calls } = makeManager({ visible: true });
    manager.setAssistantPanelOpen(false);
    // Nothing was activated, so blur() would only churn key-window state.
    assert.ok(!calls.includes("blur"), "macOS must not blur the overlay");
  });
  for (const platform of ["win32", "linux"]) {
    withPlatform(platform, () => {
      const { manager, calls } = makeManager({ visible: true });
      manager.setAssistantPanelOpen(false);
      assert.ok(calls.includes("blur"), `${platform} hands the foreground back`);
    });
  }
});

test("showDictationPanel still surfaces a hidden window while the panel is open", () => {
  const { manager, calls } = makeManager({ visible: false });
  // Panel open but the window got hidden afterwards (tray Hide raced the open).
  manager._assistantPanelOpen = true;
  manager.showDictationPanel({ focus: true });
  assert.deepEqual(calls, ["reassertAllSpaces", "showInactive", "focus"]);
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

  const metricsListener = screenListeners.find(
    (entry) => entry.event === "display-metrics-changed"
  );
  assert.ok(metricsListener, "display-metrics-changed listener registered");
  metricsListener.listener();

  assert.equal(pill.setBoundsCalls, boundsCallsBefore + 1);
  assert.deepEqual(screenListeners.map((entry) => entry.event).sort(), [
    "display-added",
    "display-metrics-changed",
    "display-removed",
  ]);
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

// macOS can pin a hidden overlay panel to a single Space (a display
// reconfiguration does it), after which every show lands on a desktop the user
// is not looking at. Every hidden → shown edge re-joins it to every Space.

test("showing a hidden pill re-joins it to every Space just before it is ordered in", () => {
  const { manager, calls } = makeManager({ visible: false });
  manager.showDictationPanel();
  assertReassertedOnceBefore(calls, "showInactive");
});

test("a minimized pill is re-joined before restore() orders it back in", () => {
  const { manager, calls } = makeManager({ visible: false, minimized: true });
  manager.showDictationPanel();
  assertReassertedOnceBefore(calls, "restore");
});

test("the first live transcript update re-joins a hidden pill before showing it", async () => {
  const { manager, calls } = makeManager({ visible: false });
  await manager.showTranscriptionPreview("hello");
  assertReassertedOnceBefore(calls, "showInactive");
});

test("the pill still shows when the Spaces re-assert could not run", () => {
  spacesReassertResult = false;
  try {
    const { manager, calls } = makeManager({ visible: false });
    manager.showDictationPanel();
    assertReassertedOnceBefore(calls, "showInactive");
  } finally {
    spacesReassertResult = true;
  }
});

test("every show of the hidden Agent companion re-joins it to every Space first", () => {
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
  assertReassertedOnceBefore(pill.calls, "showInactive");

  // The companion is hidden whenever the panel closes and reused on reopen.
  manager.hideAgentDictationPill();
  pill.calls.length = 0;
  manager.showAgentDictationPill();
  assertReassertedOnceBefore(pill.calls, "showInactive");
});

// registerMainWindowEvents also arms its 10 s first-show backstop; every timer
// test below stays inside it.
function registerMacMainWindowEvents(t, windowState) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  screenListeners.length = 0;
  const harness = makeManager(windowState);
  withPlatform("darwin", () => harness.manager.registerMainWindowEvents());
  const emitDisplayChange = (event) => {
    for (const entry of screenListeners) {
      if (entry.event === event) entry.listener();
    }
  };
  return { ...harness, emitDisplayChange };
}

// #1886: re-applying Spaces membership to a visible window blinks it, and these
// paths run on every show event, focus, preview chunk and panel toggle.
test("preservation: a visible pill is never re-asserted by show, focus, preview or panel paths", async (t) => {
  const { manager, calls, listeners } = registerMacMainWindowEvents(t, { visible: true });

  manager.showDictationPanel();
  manager.showDictationPanel({ focus: true });
  await manager.showTranscriptionPreview("partial");
  manager.completeTranscriptionPreview("final");
  listeners.get("show")();
  listeners.get("focus")();
  manager.setAssistantPanelOpen(true);
  manager.showDictationPanel();
  manager.setAssistantPanelOpen(false);

  assert.equal(countCalls(calls, "reassertAllSpaces"), 0, JSON.stringify(calls));
});

// With auto-hide off the pill never goes hidden, so the show-edge re-assert
// never runs; a display change is the known trigger, so it recovers there.
function assertRecoveredOnce(calls) {
  assert.equal(countCalls(calls, "hide"), 1, JSON.stringify(calls));
  assert.equal(countCalls(calls, "showInactive"), 1, JSON.stringify(calls));
  assertReassertedOnceBefore(calls, "showInactive");
  assert.ok(calls.indexOf("hide") < calls.indexOf("reassertAllSpaces"), JSON.stringify(calls));
}

test("a burst of display changes re-joins a visible, idle pill once, after it settles", (t) => {
  const { calls, emitDisplayChange } = registerMacMainWindowEvents(t, { visible: true });

  emitDisplayChange("display-removed");
  t.mock.timers.tick(400);
  emitDisplayChange("display-added");
  t.mock.timers.tick(400);
  emitDisplayChange("display-metrics-changed");
  t.mock.timers.tick(400);
  assert.equal(calls.length, 0, `still settling, nothing touched yet: ${JSON.stringify(calls)}`);

  t.mock.timers.tick(2_000);
  assertRecoveredOnce(calls);
});

test("a display change leaves a hidden pill to the re-assert on its next show", (t) => {
  const { calls, emitDisplayChange } = registerMacMainWindowEvents(t, { visible: false });

  emitDisplayChange("display-removed");
  t.mock.timers.tick(2_000);

  assert.deepEqual(calls, []);
});

test("a pill hidden while a display change settles is not shown again by it", (t) => {
  const { manager, calls, emitDisplayChange } = registerMacMainWindowEvents(t, { visible: true });

  emitDisplayChange("display-removed");
  manager.hideDictationPanel();
  t.mock.timers.tick(2_000);

  assert.equal(countCalls(calls, "showInactive"), 0, JSON.stringify(calls));
  assert.equal(countCalls(calls, "reassertAllSpaces"), 0, JSON.stringify(calls));
});

// A window created after the change is not pinned by it, and its first show
// re-joins it to every Space anyway.
test("a display change does nothing to a pill window recreated while it settles", (t) => {
  const { manager, calls, emitDisplayChange } = registerMacMainWindowEvents(t, { visible: true });

  emitDisplayChange("display-removed");
  const recreated = fakeWindow({ visible: true });
  manager.mainWindow = recreated.window;
  t.mock.timers.tick(2_000);

  assert.deepEqual(calls, []);
  assert.deepEqual(recreated.calls, []);
});

for (const [label, interrupt] of [
  ["the window is destroyed", ({ manager }) => (manager.mainWindow.isDestroyed = () => true)],
  ["the window is gone", ({ manager }) => (manager.mainWindow = null)],
  ["the app is quitting", ({ manager }) => (manager.isQuitting = true)],
  ["onboarding has taken over", ({ manager }) => (manager._onboardingActive = true)],
]) {
  test(`a display change does nothing once ${label}`, (t) => {
    const harness = registerMacMainWindowEvents(t, { visible: true });

    harness.emitDisplayChange("display-removed");
    interrupt(harness);
    t.mock.timers.tick(2_000);

    assert.deepEqual(harness.calls, []);
  });
}

for (const [label, setBusy, clearBusy] of [
  [
    "mic preparation",
    (manager) => manager.setDictationLifecycleState("preparing"),
    (manager) => manager.setDictationLifecycleState("idle"),
  ],
  [
    "a recording",
    (manager) => manager.setDictationLifecycleState("recording"),
    (manager) => manager.setDictationLifecycleState("idle"),
  ],
  [
    "transcription",
    (manager) => manager.setDictationLifecycleState("processing"),
    (manager) => manager.setDictationLifecycleState("idle"),
  ],
  [
    "a pill drag",
    (manager) => (manager.dragManager.isDragActive = () => true),
    (manager) => (manager.dragManager.isDragActive = () => false),
  ],
  [
    "an open Agent panel",
    (manager) => manager.setAssistantPanelOpen(true),
    (manager) => manager.setAssistantPanelOpen(false),
  ],
  [
    "an Agent command still thinking",
    (manager) => manager.setAssistantPanelBusy(true),
    (manager) => manager.setAssistantPanelBusy(false),
  ],
]) {
  test(`a display change during ${label} recovers the pill once that is over`, (t) => {
    const { manager, calls, emitDisplayChange } = registerMacMainWindowEvents(t, {
      visible: true,
    });
    setBusy(manager);

    emitDisplayChange("display-removed");
    t.mock.timers.tick(2_000);
    assert.equal(countCalls(calls, "hide"), 0, `hidden mid-${label}: ${JSON.stringify(calls)}`);

    clearBusy(manager);
    t.mock.timers.tick(2_000);
    assertRecoveredOnce(calls);
  });
}

// The companion is on screen for exactly as long as the Agent panel is open,
// which the pill waits out, so the companion is recovered on its own with the
// panel left open. It never takes focus, so cycling it costs the panel nothing.
function registerMacCompanion(t) {
  const harness = registerMacMainWindowEvents(t, { visible: true });
  // makeManager stubs the companion out; these tests need the real one.
  delete harness.manager.showAgentDictationPill;
  delete harness.manager.hideAgentDictationPill;
  createdBrowserWindows.length = 0;
  withPlatform("darwin", () => harness.manager.setAssistantPanelOpen(true));
  const pill = createdBrowserWindows.at(-1);
  pill.webContentsListeners.get("did-finish-load")();
  harness.calls.length = 0;
  pill.calls.length = 0;
  return { ...harness, pill };
}

const COMPANION_RECOVERY = ["hide", "reassertAllSpaces", "showInactive", "moveTop"];

test("a display change re-joins the visible companion once, with the Agent panel left open", (t) => {
  const { calls, pill, emitDisplayChange } = registerMacCompanion(t);

  emitDisplayChange("display-removed");
  t.mock.timers.tick(700);
  assert.deepEqual(pill.calls, [], "still settling");

  t.mock.timers.tick(100);
  assert.deepEqual(pill.calls, COMPANION_RECOVERY);

  // The pill keeps waiting out the open panel; the companion is not cycled again.
  t.mock.timers.tick(5_000);
  assert.deepEqual(pill.calls, COMPANION_RECOVERY);
  assert.deepEqual(calls, [], "the pill holds the panel's keyboard focus: untouched");
});

test("a burst of display changes re-joins the companion once, after it settles", (t) => {
  const { pill, emitDisplayChange } = registerMacCompanion(t);

  emitDisplayChange("display-removed");
  t.mock.timers.tick(400);
  emitDisplayChange("display-added");
  t.mock.timers.tick(400);
  emitDisplayChange("display-metrics-changed");
  t.mock.timers.tick(400);
  assert.deepEqual(pill.calls, [], "still settling");

  t.mock.timers.tick(2_000);
  assert.deepEqual(pill.calls, COMPANION_RECOVERY);
});

test("once the Agent panel closes the pill is recovered, and the companion stays hidden", (t) => {
  const { manager, calls, pill, emitDisplayChange } = registerMacCompanion(t);

  emitDisplayChange("display-removed");
  t.mock.timers.tick(2_000);
  withPlatform("darwin", () => manager.setAssistantPanelOpen(false));
  t.mock.timers.tick(2_000);

  assertRecoveredOnce(calls);
  assert.deepEqual(pill.calls, [...COMPANION_RECOVERY, "hide"]);
});

test("a companion hidden while a display change settles is not shown again by it", (t) => {
  const { manager, pill, emitDisplayChange } = registerMacCompanion(t);

  emitDisplayChange("display-removed");
  manager.hideAgentDictationPill();
  t.mock.timers.tick(2_000);

  assert.deepEqual(pill.calls, ["hide"]);
  assert.equal(pill.isVisible(), false);
});

for (const [label, interrupt] of [
  ["destroyed", (pill) => (pill.isDestroyed = () => true)],
  ["closed", (pill) => pill.close()],
]) {
  test(`a display change does nothing to a companion ${label} while it settles`, (t) => {
    const { pill, emitDisplayChange } = registerMacCompanion(t);

    emitDisplayChange("display-removed");
    interrupt(pill);
    t.mock.timers.tick(2_000);

    assert.deepEqual(pill.calls, []);
  });
}

for (const [label, setBusy, clearBusy] of [
  [
    "a recording",
    (manager) => manager.setDictationLifecycleState("recording"),
    (manager) => manager.setDictationLifecycleState("idle"),
  ],
  [
    "a pill drag",
    (manager) => (manager.dragManager.isDragActive = () => true),
    (manager) => (manager.dragManager.isDragActive = () => false),
  ],
]) {
  test(`a display change during ${label} recovers the companion once that is over`, (t) => {
    const { manager, calls, pill, emitDisplayChange } = registerMacCompanion(t);
    setBusy(manager);

    emitDisplayChange("display-removed");
    t.mock.timers.tick(2_000);
    assert.deepEqual(pill.calls, [], `cycled mid-${label}`);

    clearBusy(manager);
    t.mock.timers.tick(2_000);
    assert.deepEqual(pill.calls, COMPANION_RECOVERY);
    assert.deepEqual(calls, []);
  });
}

test("display changes never hide or re-show the pill on Windows or Linux", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => t.mock.timers.reset());
  for (const platform of ["win32", "linux"]) {
    screenListeners.length = 0;
    const { manager, calls } = makeManager({ visible: true });
    withPlatform(platform, () => manager.registerMainWindowEvents());

    for (const { listener } of screenListeners) listener();
    t.mock.timers.tick(2_000);

    assert.equal(countCalls(calls, "hide"), 0, platform);
    assert.equal(countCalls(calls, "reassertAllSpaces"), 0, platform);
  }
});
