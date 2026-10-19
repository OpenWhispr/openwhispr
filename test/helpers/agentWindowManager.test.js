const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// The agent window's main-process side with Electron stubbed: placement,
// focus per platform, the voice state that keeps dictation off the mic,
// readiness, crashes, and sender checks.
const displays = [
  { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
  { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
];
let cursor = { x: 100, y: 100 };
const screenListeners = new Map();
const created = [];
const inputRegionCalls = [];

const contains = (area, point) =>
  point.x >= area.x &&
  point.x < area.x + area.width &&
  point.y >= area.y &&
  point.y < area.y + area.height;
const displayNearest = (point) =>
  displays.find((display) => contains(display.workArea, point)) ?? displays[0];

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.visible = false;
    this.focused = false;
    this.destroyed = false;
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.listeners = new Map();
    this.sent = [];
    this.contentsListeners = new Map();
    const mainFrame = {};
    this.webContents = {
      mainFrame,
      on: (event, listener) => this.contentsListeners.set(event, listener),
      send: (channel, payload) => this.sent.push({ channel, payload }),
    };
    created.push(this);
  }
  on(event, listener) {
    this.listeners.set(event, listener);
  }
  setContentProtection(value) {
    this.calls.push(["setContentProtection", value]);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  isVisible() {
    return this.visible;
  }
  isFocused() {
    return this.focused;
  }
  showInactive() {
    this.visible = true;
    this.calls.push(["showInactive"]);
  }
  hide() {
    this.visible = false;
    this.calls.push(["hide"]);
  }
  moveTop() {}
  getBounds() {
    return this.bounds;
  }
  setBounds(bounds) {
    this.bounds = bounds;
    this.calls.push(["setBounds", bounds]);
  }
  setFocusable(value) {
    this.calls.push(["setFocusable", value]);
  }
  focus() {
    this.focused = true;
    this.calls.push(["focus"]);
  }
  blur() {
    this.focused = false;
    this.calls.push(["blur"]);
  }
}

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      BrowserWindow: FakeBrowserWindow,
      Menu: { buildFromTemplate: () => ({ popup() {} }) },
      screen: {
        getAllDisplays: () => displays,
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: displayNearest,
        getDisplayMatching: (rect) => displayNearest({ x: rect.x, y: rect.y }),
        on: (event, listener) => screenListeners.set(event, listener),
      },
    };
  }
  if (request === "./debugLogger") return { warn() {}, debug() {} };
  if (request === "./linuxWindowInputRegion") {
    return {
      createLinuxWindowInputRegion: () => ({
        focus: async () => inputRegionCalls.push("focus"),
        stop: () => inputRegionCalls.push("stop"),
      }),
    };
  }
  if (request === "./windowConfig") {
    return {
      AGENT_WINDOW_CONFIG: { transparent: true },
      WindowPositionUtil: { setupAlwaysOnTop() {} },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { AgentWindowManager } = require("../../src/helpers/agentWindowManager");
const { AGENT_LAYOUT_SIZES } = require("../../src/helpers/agentWindowPlacement");
Module._load = originalLoad;

function createWindowManager(overrides = {}) {
  const events = [];
  return {
    events,
    _onboardingActive: false,
    _panelStartPosition: "bottom-right",
    isQuitting: false,
    mainWindow: null,
    hotkeyManager: { isInListeningMode: () => false },
    textEditMonitor: { captureTargetPid: async () => 42 },
    selectionManager: { captureTarget: async () => events.push("captureTarget") },
    isDictationActive: () => false,
    syncUserRecording: () => events.push("syncUserRecording"),
    registerExternalLinkHandlers: () => undefined,
    loadWindowContent: async (_win, _isControlPanel, query) => events.push(["load", query]),
    _resolveActiveDisplay: async () => displayNearest(cursor),
    ...overrides,
  };
}

async function openedManager({ platform = "darwin", windowManager = createWindowManager() } = {}) {
  created.length = 0;
  const manager = new AgentWindowManager(windowManager, { platform });
  manager.handleHotkey();
  const win = manager.window;
  manager.markReady({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  await new Promise((resolve) => setImmediate(resolve));
  return { manager, win, windowManager };
}

const fromAgent = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });

test("the hotkey loads ?agent=true and shows the pill at the bottom center of the display", async () => {
  cursor = { x: 100, y: 100 };
  const { win, windowManager } = await openedManager();

  assert.deepEqual(windowManager.events[0], ["load", { agent: "true" }]);
  assert.ok(win.visible);
  const { width, height } = AGENT_LAYOUT_SIZES.pill;
  assert.deepEqual(win.bounds, { x: (1440 - width) / 2, y: 900 - 4 - height, width, height });
  assert.deepEqual(win.calls[0], ["setContentProtection", true]);
});

test("a press before the renderer is ready reaches it once it is", () => {
  created.length = 0;
  const manager = new AgentWindowManager(createWindowManager(), { platform: "darwin" });
  manager.handleHotkey();
  const win = manager.window;
  assert.deepEqual(win.sent, []);

  manager.markReady(fromAgent(win));
  assert.deepEqual(win.sent, [{ channel: "agent-window-hotkey", payload: { external: true } }]);
});

test("layouts keep the bottom-center anchor and only a layout change sets bounds", async () => {
  const { manager, win } = await openedManager();
  const anchorBottom = win.bounds.y + win.bounds.height;
  const before = win.calls.filter(([name]) => name === "setBounds").length;

  assert.equal(manager.setLayout(fromAgent(win), { layout: "modal", focus: false }), true);
  const { width, height } = AGENT_LAYOUT_SIZES.modal;
  assert.deepEqual(win.bounds, { x: (1440 - width) / 2, y: anchorBottom - height, width, height });

  manager.setLayout(fromAgent(win), { layout: "modal", focus: true });
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
  const after = win.calls.filter(([name]) => name === "setBounds").length;
  assert.equal(after - before, 1);
});

test("a modal taller than the work area shrinks to it", async () => {
  const short = { id: 3, workArea: { x: 0, y: 0, width: 800, height: 400 } };
  displays.push(short);
  try {
    const { manager, win } = await openedManager({
      windowManager: createWindowManager({ _resolveActiveDisplay: async () => short }),
    });
    manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
    assert.equal(win.bounds.height, 400);
    assert.equal(win.bounds.y, 0);
  } finally {
    displays.pop();
  }
});

test("the pill sits above a dictation pill docked in the center of the same display", async () => {
  cursor = { x: 100, y: 100 };
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 616, y: 776, width: 208, height: 120 }),
  };
  const { win } = await openedManager({
    windowManager: createWindowManager({ _panelStartPosition: "center", mainWindow }),
  });
  // Dictation pill top: 776 + 120 - 12 - 40 = 844; 8px above it.
  assert.equal(win.bounds.y + win.bounds.height, 836);
});

test("macOS never focuses: the panel is focusable from creation and a click makes it key", async () => {
  const { manager, win } = await openedManager({ platform: "darwin" });
  assert.equal(win.options.focusable, true);

  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  assert.deepEqual(
    win.calls.filter(([name]) => ["focus", "blur", "setFocusable"].includes(name)),
    []
  );
});

test("Windows takes focus for typing and blurs before giving it back", async () => {
  const { manager, win } = await openedManager({ platform: "win32" });
  assert.equal(win.options.focusable, false);

  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  assert.deepEqual(
    win.calls.filter(([name]) => ["focus", "blur", "setFocusable"].includes(name)),
    [["setFocusable", true], ["focus"], ["blur"], ["setFocusable", false]]
  );
});

test("Linux focuses through the input-region helper and remaps to hand focus back", async () => {
  inputRegionCalls.length = 0;
  const { manager, win } = await openedManager({ platform: "linux" });
  assert.equal(win.options.focusable, false);

  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(inputRegionCalls, ["focus"]);

  win.calls.length = 0;
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    win.calls.filter(([name]) => ["hide", "showInactive"].includes(name)),
    [["hide"], ["showInactive"]]
  );
});

test("Linux re-takes focus on a click while the user is typing", async () => {
  inputRegionCalls.length = 0;
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setImmediate(resolve));
  inputRegionCalls.length = 0;

  win.contentsListeners.get("input-event")({}, { type: "mouseDown" });
  assert.deepEqual(inputRegionCalls, ["focus"]);
});

test("another window's messages are refused", async () => {
  const { manager, win } = await openedManager();
  const other = new FakeBrowserWindow({ width: 10, height: 10 });
  const foreign = { sender: other.webContents, senderFrame: other.webContents.mainFrame };
  const subframe = { sender: win.webContents, senderFrame: {} };

  assert.equal(manager.setLayout(foreign, { layout: "modal", focus: true }), false);
  assert.equal(manager.setLayout(subframe, { layout: "modal", focus: true }), false);
  assert.equal(manager.hide(foreign), false);
  assert.equal(manager.setVoiceState(foreign, "recording"), false);
  assert.equal(manager.layout, "pill");
  assert.ok(win.visible);
  assert.equal(manager.isRecording(), false);
});

test("the agent's take keeps dictation off the mic, and dictation keeps the agent off", async () => {
  let dictating = false;
  const { manager, win, windowManager } = await openedManager({
    windowManager: createWindowManager({ isDictationActive: () => dictating }),
  });

  assert.equal(manager.setVoiceState(fromAgent(win), "recording"), true);
  assert.equal(manager.isRecording(), true);
  assert.ok(windowManager.events.includes("syncUserRecording"));
  manager.setVoiceState(fromAgent(win), "idle");

  dictating = true;
  assert.equal(manager.setVoiceState(fromAgent(win), "recording"), false);
  assert.equal(manager.isRecording(), false);
  win.sent.length = 0;
  manager.handleHotkey();
  assert.deepEqual(win.sent, []);
});

test("a crashed renderer releases the mic and the next press recreates the window", async () => {
  const { manager, win } = await openedManager();
  manager.setVoiceState(fromAgent(win), "recording");

  win.contentsListeners.get("render-process-gone")({}, { reason: "crashed" });
  assert.equal(manager.isRecording(), false);
  assert.equal(manager.window, null);
  assert.ok(win.destroyed);

  manager.handleHotkey();
  assert.notEqual(manager.window, win);
});

test("a reloaded renderer starts hidden and without a take, like a new one", async () => {
  const { manager, win } = await openedManager();
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
  manager.setVoiceState(fromAgent(win), "recording");

  win.contentsListeners.get("did-start-loading")();
  assert.equal(win.visible, false);
  assert.equal(manager.isRecording(), false);
  assert.equal(win.bounds.width, AGENT_LAYOUT_SIZES.pill.width);

  const sent = win.sent.length;
  manager.handleHotkey();
  assert.equal(win.sent.length, sent, "the new renderer is not ready yet");
  manager.markReady(fromAgent(win));
  assert.deepEqual(win.sent.at(-1), { channel: "agent-window-hotkey", payload: { external: true } });
});

test("closing hides instead of destroying, and the next show starts from the pill", async () => {
  const { manager, win } = await openedManager();
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });

  let prevented = false;
  win.listeners.get("close")({ preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  assert.equal(win.visible, false);
  assert.equal(win.bounds.width, AGENT_LAYOUT_SIZES.pill.width);
  assert.equal(manager.window, win);
});

test("onboarding refuses the hotkey and dismisses an open window", async () => {
  const windowManager = createWindowManager();
  const { manager, win } = await openedManager({ windowManager });
  win.sent.length = 0;

  windowManager._onboardingActive = true;
  manager.handleHotkey();
  manager.open();
  assert.equal(manager.deliverCommand({ text: "hi" }), false);
  assert.deepEqual(win.sent, []);

  manager.dismiss();
  assert.deepEqual(win.sent, [{ channel: "agent-window-dismiss", payload: undefined }]);
  assert.equal(win.visible, false);
});

test("a wake-word command carries its selection as context from another app", async () => {
  const { manager, win } = await openedManager();
  win.sent.length = 0;

  assert.equal(manager.deliverCommand({ text: "  ", attachment: null }), false);
  manager.deliverCommand({
    text: "summarize this",
    attachment: { image: "AAAA", mediaType: "image/jpeg", extra: 1 },
    selectedContext: { text: "Q4 notes", sourceMessageId: "x" },
  });
  assert.deepEqual(win.sent, [
    {
      channel: "agent-window-command",
      payload: {
        text: "summarize this",
        attachment: { image: "AAAA", mediaType: "image/jpeg" },
        selectedContext: { text: "Q4 notes", source: "external" },
      },
    },
  ]);
});

test("when its display goes away the window moves to the cursor's", async () => {
  cursor = { x: 1500, y: 100 };
  const { win } = await openedManager();
  assert.ok(win.bounds.x >= 1440);

  const removed = displays.splice(1, 1);
  try {
    cursor = { x: 100, y: 100 };
    screenListeners.get("display-removed")();
    assert.ok(win.bounds.x < 1440);
  } finally {
    displays.splice(1, 0, ...removed);
  }
});
