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
// KDE's per-monitor work areas (plasmaWorkAreas.js), by display id.
const plasmaCorrections = new Map();
let plasmaRefreshes = 0;
const screenListeners = new Map();
const created = [];

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
    // What the Linux input-region helper was asked for this window.
    this.helperCalls = [];
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
    this.focused = false;
    this.calls.push(["hide"]);
  }
  moveTop() {}
  getBounds() {
    return this.bounds;
  }
  getPosition() {
    return [this.bounds.x, this.bounds.y];
  }
  setPosition(x, y) {
    this.bounds = { ...this.bounds, x, y };
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
  if (request === "./debugLogger") return { warn() {}, debug() {}, info() {} };
  if (request === "./plasmaWorkAreas") {
    return {
      plasmaWorkAreas: {
        refresh: async () => {
          plasmaRefreshes += 1;
        },
        resolve: (display) =>
          plasmaCorrections.has(display.id)
            ? { ...display, workArea: plasmaCorrections.get(display.id) }
            : display,
      },
    };
  }
  if (request === "./linuxWindowInputRegion") {
    return {
      createLinuxWindowInputRegion: (win) => ({
        focus: async () => win.helperCalls.push("focus"),
        stop: () => win.helperCalls.push("stop"),
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
const { AGENT_LAYOUT_SIZES, WAITING_PILL_SIZE } = require("../../src/helpers/agentWindowPlacement");
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

for (const platform of ["darwin", "win32", "linux"]) {
  test(`a dragged dock keeps dictation clearance on drag and reopen on ${platform}`, async (t) => {
    cursor = { x: 720, y: 400 };
    let dictationVisible = false;
    const { manager, win } = await openedManager({
      platform,
      windowManager: createWindowManager({
        _panelStartPosition: "center",
        mainWindow: {
          isDestroyed: () => false,
          isVisible: () => dictationVisible,
          getBounds: () => ({ x: 616, y: 776, width: 208, height: 120 }),
        },
      }),
    });
    t.after(() => manager.dragManager.cleanup());
    manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
    manager.setDragging(fromAgent(win), true);
    cursor = { x: 720, y: 9000 };
    manager.dragManager.updateWindowPosition();
    manager.setDragging(fromAgent(win), false);
    assert.equal(manager.anchor.bottom, 896);

    dictationVisible = true;
    manager.hide(fromAgent(win));
    cursor = { x: 720, y: 400 };
    manager.handleHotkey();
    await new Promise((resolve) => setImmediate(resolve));
    const ceiling = platform === "win32" ? 768 : 836;
    assert.equal(win.bounds.y + win.bounds.height, ceiling, "restored dock clears dictation");
    manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
    manager.setDragging(fromAgent(win), true);
    cursor = { x: 720, y: 9000 };
    manager.dragManager.updateWindowPosition();
    manager.setDragging(fromAgent(win), false);
    manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
    assert.equal(win.bounds.y + win.bounds.height, ceiling, "dragged dock clears dictation");
  });

  test(`a dragged modal keeps its dock across layouts and reopening on ${platform}`, async (t) => {
    cursor = { x: 720, y: 400 };
    const { manager, win } = await openedManager({ platform });
    t.after(() => manager.dragManager.cleanup());
    manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
    manager.setDragging(fromAgent(win), true);
    cursor = { x: 620, y: 264 };
    manager.dragManager.updateWindowPosition();
    manager.setDragging(fromAgent(win), false);
    assert.deepEqual(manager.anchor, { centerX: 620, bottom: 760 });
    assert.equal(win.bounds.y + win.bounds.height, 760);

    manager.setLayout(fromAgent(win), { layout: "typing", focus: false });
    assert.equal(win.bounds.x + win.bounds.width / 2, 620);
    assert.equal(win.bounds.y + win.bounds.height, 760);
    manager.hide(fromAgent(win));
    manager.handleHotkey();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(win.bounds.x + win.bounds.width / 2, 620);
    assert.equal(win.bounds.y + win.bounds.height, 760);

    manager.hide(fromAgent(win));
    cursor = { x: 2000, y: 500 };
    manager.handleHotkey();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(win.bounds.x + win.bounds.width / 2, 2400, "another display uses its own dock");
    manager.hide(fromAgent(win));
    cursor = { x: 620, y: 264 };
    manager.handleHotkey();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(win.bounds.x + win.bounds.width / 2, 620);
  });
}

test("dragging stays in the lower centered region and stops when the modal leaves", async (t) => {
  cursor = { x: 720, y: 400 };
  const { manager, win } = await openedManager();
  t.after(() => manager.dragManager.cleanup());
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
  manager.setDragging(fromAgent(win), true);
  cursor = { x: -4000, y: -4000 };
  manager.dragManager.updateWindowPosition();
  assert.ok(manager.anchor.bottom - AGENT_LAYOUT_SIZES.pill.height >= 900 * 0.6);
  for (const layout of ["modal", "typing", "pill"]) {
    manager.setLayout(fromAgent(win), { layout, focus: false });
    assert.ok(win.bounds.x >= 1440 * 0.06 - 1);
    assert.ok(win.bounds.y >= 0);
  }
  assert.equal(manager.dragManager.isDragActive(), false);
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
  manager.setDragging(fromAgent(win), true);
  cursor = { x: 9000, y: 9000 };
  manager.dragManager.updateWindowPosition();
  assert.ok(win.bounds.x + win.bounds.width <= 1440 * 0.94 + 1);
  assert.ok(win.bounds.y + win.bounds.height <= 896);
  manager.hide(fromAgent(win));
  assert.equal(manager.dragManager.isDragActive(), false);
});

test("other windows and subframes cannot start or stop an assistant drag", async (t) => {
  cursor = { x: 720, y: 400 };
  const { manager, win } = await openedManager();
  t.after(() => manager.dragManager.cleanup());
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
  for (const event of [{}, { sender: win.webContents, senderFrame: {} }]) {
    manager.setDragging(event, true);
    assert.equal(manager.dragManager.isDragActive(), false);
  }
  manager.setDragging(fromAgent(win), true);
  manager.setDragging({}, false);
  assert.equal(manager.dragManager.isDragActive(), true);
  manager._forget();
  assert.equal(manager.dragManager.isDragActive(), false);
});

test("the hotkey loads ?agent=true and shows the pill at the bottom center of the display", async () => {
  cursor = { x: 100, y: 100 };
  const { win, windowManager } = await openedManager();

  assert.deepEqual(windowManager.events[0], ["load", { agent: "true" }]);
  assert.ok(win.visible);
  const { width, height } = AGENT_LAYOUT_SIZES.pill;
  assert.deepEqual(win.bounds, { x: (1440 - width) / 2, y: 900 - 4 - height, width, height });
  assert.deepEqual(win.calls[0], ["setContentProtection", true]);
});

test("only the pill that reads Waiting for answer widens the pill window", async () => {
  const { manager, win } = await openedManager();
  // The reference's waiting pill is 287px wide, its idle pill 173px; 8px shadow margins.
  assert.ok(WAITING_PILL_SIZE.width >= 287 + 2 * 8);
  assert.ok(AGENT_LAYOUT_SIZES.pill.width >= 173 + 2 * 8);
  assert.ok(AGENT_LAYOUT_SIZES.pill.width < WAITING_PILL_SIZE.width);

  manager.setLayout(fromAgent(win), { layout: "pill", focus: false, wide: true });
  assert.equal(win.bounds.width, WAITING_PILL_SIZE.width);
  assert.equal(win.bounds.x, (1440 - WAITING_PILL_SIZE.width) / 2, "still centered");
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  assert.equal(win.bounds.width, AGENT_LAYOUT_SIZES.pill.width);
  // Only the pill is ever widened.
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false, wide: true });
  assert.equal(win.bounds.width, AGENT_LAYOUT_SIZES.modal.width);
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

test("a standalone card sizes the window to the card, within bounds, above the pill", async () => {
  const { manager, win } = await openedManager();
  const anchorBottom = win.bounds.y + win.bounds.height;
  const shadow = 8;
  const height = (card) => shadow + card + 12 + 40 + shadow;

  assert.equal(
    manager.setLayout(fromAgent(win), { layout: "standalone", focus: false, contentHeight: 180 }),
    true
  );
  assert.deepEqual(win.bounds, {
    x: (1440 - 436) / 2,
    y: anchorBottom - height(180),
    width: 436,
    height: height(180),
  });
  manager.setLayout(fromAgent(win), { layout: "standalone", focus: false, contentHeight: 5 });
  assert.equal(win.bounds.height, height(80), "never shorter than a card can be");
  manager.setLayout(fromAgent(win), { layout: "standalone", focus: false, contentHeight: 900 });
  assert.equal(win.bounds.height, height(400), "a taller card scrolls inside");
});

test("a standalone layout needs the card's measured height", async () => {
  const { manager, win } = await openedManager();
  const before = { ...win.bounds };
  for (const contentHeight of [undefined, Number.NaN, Infinity, "180"]) {
    assert.equal(
      manager.setLayout(fromAgent(win), { layout: "standalone", focus: false, contentHeight }),
      false,
      String(contentHeight)
    );
  }
  assert.deepEqual(win.bounds, before);
  // Other layouts ignore it.
  assert.equal(manager.setLayout(fromAgent(win), { layout: "modal", focus: false }), true);
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

test("on Windows the window sits above the whole dictation window, which takes every click", async () => {
  cursor = { x: 100, y: 100 };
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 616, y: 776, width: 208, height: 120 }),
  };
  const { win } = await openedManager({
    platform: "win32",
    windowManager: createWindowManager({ _panelStartPosition: "center", mainWindow }),
  });
  assert.equal(win.bounds.y + win.bounds.height, 768);
});

test("Ask assistant opens on the cursor's display, not the last dictation target's", async () => {
  cursor = { x: 100, y: 100 };
  created.length = 0;
  const manager = new AgentWindowManager(
    createWindowManager({ _resolveActiveDisplay: async () => displays[1] }),
    { platform: "darwin" }
  );
  manager.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(manager.window.bounds.x < 1440);
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

test("Windows: a standalone card that only changes height never takes the keyboard back", async () => {
  const { manager, win } = await openedManager({ platform: "win32" });
  const focusCalls = () => win.calls.filter(([name]) => name === "focus").length;
  manager.setLayout(fromAgent(win), { layout: "standalone", focus: true, contentHeight: 120 });
  assert.equal(focusCalls(), 1);
  // The user went to Settings; the card grew a Done button.
  manager.setLayout(fromAgent(win), { layout: "standalone", focus: true, contentHeight: 160 });
  assert.equal(win.bounds.height, AGENT_LAYOUT_SIZES.standalone.height - 80 + 160);
  assert.equal(focusCalls(), 1, "resized without focusing");
  // A real change still asks: the keyboard released, then wanted again.
  manager.setLayout(fromAgent(win), { layout: "standalone", focus: false, contentHeight: 160 });
  manager.setLayout(fromAgent(win), { layout: "standalone", focus: true, contentHeight: 160 });
  assert.equal(focusCalls(), 2);
});

test("Windows releases the keyboard only from a focused window, and hides first", async () => {
  const { manager, win } = await openedManager({ platform: "win32" });
  const focusCalls = () =>
    win.calls.filter(([name]) => ["hide", "focus", "blur", "setFocusable"].includes(name));

  // The user clicked another app while typing: nothing to blur.
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  win.focused = false;
  win.calls.length = 0;
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  assert.deepEqual(focusCalls(), [["setFocusable", false]]);

  // A close while typing hides before letting go, so no blur moves the foreground.
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  win.calls.length = 0;
  assert.equal(manager.hide(fromAgent(win)), true);
  assert.deepEqual(focusCalls(), [["hide"], ["setFocusable", false]]);
});

test("Linux hides without remapping: unmapping alone hands focus back", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setImmediate(resolve));
  win.calls.length = 0;

  manager.hide(fromAgent(win));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    win.calls.filter(([name]) => ["hide", "showInactive"].includes(name)),
    [["hide"]]
  );
});

test("Linux focuses through the input-region helper and remaps to hand focus back", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  assert.equal(win.options.focusable, false);

  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(win.helperCalls, ["focus"]);

  win.calls.length = 0;
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    win.calls.filter(([name]) => ["hide", "showInactive"].includes(name)),
    [["hide"], ["showInactive"]]
  );
});

test("Linux makes the window focusable before the helper focuses it, and unfocusable on release", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  // One timeline for the window's calls and the helper's, to see their order.
  const setFocusable = win.setFocusable.bind(win);
  win.setFocusable = (value) => {
    win.helperCalls.push(["setFocusable", value]);
    setFocusable(value);
  };

  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(win.helperCalls, [["setFocusable", true], "focus"]);

  win.helperCalls.length = 0;
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(win.helperCalls, [["setFocusable", false]]);
});

test("Linux asks the helper once more when the window didn't take focus", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus", "focus"], "still unfocused: once more");

  win.helperCalls.length = 0;
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  await new Promise((resolve) => setImmediate(resolve));
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  win.focused = true;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus"], "focused: no second request");
});

test("Linux sends no retry once the keyboard is handed back, and one when it is asked for again", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus"], "handed back within 250 ms: no retry");

  win.helperCalls.length = 0;
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  manager.setLayout(fromAgent(win), { layout: "pill", focus: false });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus", "focus", "focus"], "two requests, one retry");
});

test("Linux does not retry after focus succeeded and the user switched away", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  win.focused = true;
  win.listeners.get("focus")?.();
  win.focused = false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus"], "a successful request cannot take focus back");
});

test("Linux layout changes while already focused cannot schedule a focus-stealing retry", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  win.focused = true;
  win.listeners.get("focus")?.();
  manager.setLayout(fromAgent(win), { layout: "modal", focus: true });
  win.focused = false;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus"], "the focused window needed no new request");
});

test("Linux: a second request while focused leaves one retry, from the latest request", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  // A layout change that keeps the keyboard asks for it again, with no release between.
  manager.setLayout(fromAgent(win), { layout: "modal", focus: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(win.helperCalls, ["focus", "focus", "focus"], "two requests, one retry");
});

test("Linux re-takes focus on a click while the user is typing", async () => {
  const { manager, win } = await openedManager({ platform: "linux" });
  manager.setLayout(fromAgent(win), { layout: "typing", focus: true });
  await new Promise((resolve) => setImmediate(resolve));
  win.helperCalls.length = 0;

  win.contentsListeners.get("input-event")({}, { type: "mouseDown" });
  assert.deepEqual(win.helperCalls, ["focus"]);
});

test("another window's messages are refused", async () => {
  const { manager, win } = await openedManager();
  const other = new FakeBrowserWindow({ width: 10, height: 10 });
  const foreign = { sender: other.webContents, senderFrame: other.webContents.mainFrame };
  const subframe = { sender: win.webContents, senderFrame: {} };

  assert.equal(manager.setLayout(foreign, { layout: "modal", focus: true }), false);
  assert.equal(manager.setLayout(subframe, { layout: "modal", focus: true }), false);
  assert.equal(manager.hide(foreign), false);
  assert.equal(manager.setVoiceState(foreign, "recording", "take-1"), false);
  assert.equal(manager.layout, "pill");
  assert.ok(win.visible);
  assert.equal(manager.isRecording(), false);
});

test("the agent's take keeps dictation off the mic, and dictation keeps the agent off", async () => {
  let dictating = false;
  const { manager, win, windowManager } = await openedManager({
    windowManager: createWindowManager({ isDictationActive: () => dictating }),
  });

  assert.equal(manager.setVoiceState(fromAgent(win), "recording", "take-1"), true);
  assert.equal(manager.isRecording(), true);
  assert.ok(windowManager.events.includes("syncUserRecording"));
  manager.setVoiceState(fromAgent(win), "idle", "take-1");

  dictating = true;
  assert.equal(manager.setVoiceState(fromAgent(win), "recording", "take-1"), false);
  assert.equal(manager.isRecording(), false);
  win.sent.length = 0;
  manager.handleHotkey();
  // Ask assistant too: its typing layout would take the keyboard, and the paste.
  manager.open();
  assert.deepEqual(win.sent, []);
});

test("the dictation window hears when the agent takes and releases the mic", async () => {
  const toDictation = [];
  const windowManager = createWindowManager({
    mainWindow: {
      isDestroyed: () => false,
      webContents: { send: (channel, value) => toDictation.push([channel, value]) },
    },
  });
  const { manager, win } = await openedManager({ windowManager });

  manager.setVoiceState(fromAgent(win), "recording", "take-1");
  manager.setVoiceState(fromAgent(win), "transcribing", "take-1");
  manager.setVoiceState(fromAgent(win), "idle", "take-1");
  assert.deepEqual(toDictation, [
    ["agent-recording-changed", true],
    ["agent-recording-changed", false],
  ]);
});

test("a crashed renderer releases the mic and the next press recreates the window", async () => {
  const { manager, win } = await openedManager();
  manager.setVoiceState(fromAgent(win), "recording", "take-1");

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
  manager.setVoiceState(fromAgent(win), "recording", "take-1");

  // Only a committed main-frame navigation is a new renderer: an in-page one
  // (a footnote link) never reports one, and a navigation will-navigate
  // blocks (a dropped file) starts but never commits.
  assert.equal(win.contentsListeners.has("did-start-navigation"), false);
  assert.equal(win.contentsListeners.has("did-navigate-in-page"), false);
  assert.equal(win.visible, true);
  assert.equal(manager.isRecording(), true);

  win.contentsListeners.get("did-navigate")({}, "http://app/?agent=true", 200, "OK");
  assert.equal(win.visible, false);
  assert.equal(manager.isRecording(), false);
  assert.equal(win.bounds.width, AGENT_LAYOUT_SIZES.pill.width);

  const sent = win.sent.length;
  manager.handleHotkey();
  assert.equal(win.sent.length, sent, "the new renderer is not ready yet");
  manager.markReady(fromAgent(win));
  assert.deepEqual(win.sent.at(-1), {
    channel: "agent-window-hotkey",
    payload: { external: true },
  });
});

test("closing hides instead of destroying, tells the renderer, and the next show starts from the pill", async () => {
  const { manager, win } = await openedManager();
  manager.setLayout(fromAgent(win), { layout: "modal", focus: false });
  win.sent.length = 0;

  let prevented = false;
  win.listeners.get("close")({ preventDefault: () => (prevented = true) });
  assert.ok(prevented);
  // Alt+F4 or Cmd+W: the renderer drops its take and turn and resets its layout.
  assert.deepEqual(win.sent, [{ channel: "agent-window-dismiss", payload: undefined }]);
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

test("on KDE the window stays above each monitor's own panel", async () => {
  // Plasma's work area for the second monitor: a 44px panel along its bottom.
  plasmaCorrections.set(2, { x: 1440, y: 0, width: 1920, height: 1036 });
  try {
    cursor = { x: 1500, y: 100 };
    created.length = 0;
    plasmaRefreshes = 0;
    const manager = new AgentWindowManager(createWindowManager(), { platform: "darwin" });
    manager.open();
    await new Promise((resolve) => setImmediate(resolve));
    const bottom = () => manager.window.bounds.y + manager.window.bounds.height;
    assert.equal(bottom(), 1036 - 4, "Ask assistant, on the cursor's display");
    assert.equal(plasmaRefreshes, 1, "a show asks Plasma again");

    plasmaCorrections.set(2, { x: 1440, y: 0, width: 1920, height: 1020 });
    screenListeners.get("display-metrics-changed")();
    assert.equal(bottom(), 1020 - 4, "a display change, on the window's display");
  } finally {
    plasmaCorrections.clear();
  }
});
