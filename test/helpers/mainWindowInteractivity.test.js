const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
let applyInputRegion;
let focusInputRegion;

// Load the real WindowManager with the module surface it touches at require
// time. setMainWindowInteractivity only reads `this.mainWindow`, so the tests
// call it on a minimal receiver instead of constructing a whole manager.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getPrimaryDisplay: () => ({}),
        on: () => undefined,
      },
      BrowserWindow: class {},
      shell: {},
      dialog: {},
      ipcMain: { on: () => undefined, handle: () => undefined },
      Menu: {},
    };
  }
  if (request === "./debugLogger") {
    return { warn: () => undefined, debug: () => undefined, info: () => undefined };
  }
  if (request === "./linuxWindowInputRegion") {
    return {
      createLinuxWindowInputRegion: () => ({
        set: (region) => applyInputRegion(region),
        focus: () => focusInputRegion(),
        stop: () => undefined,
      }),
    };
  }
  if (request === "./hotkeyManager") return class {};
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") {
    return {
      DEV_SERVER_PORT: 5173,
      DEV_SERVER_URL: "http://localhost:5173",
      getAppFilePath: () => ({ path: "/app/index.html", query: {} }),
      waitForDevServer: () => Promise.resolve(),
    };
  }
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig") {
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: {},
      WindowPositionUtil: { setupAlwaysOnTop: () => undefined },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

const fakeWindow = () => {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    setIgnoreMouseEvents: (ignore, options) => calls.push({ ignore, options }),
  };
};

// Hover in, hover out, hover in again — the sequence App.jsx drives from the
// pill's mouseenter/mouseleave handlers.
const hoverCycle = (platform, win = fakeWindow()) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    const setInteractivity = WindowManager.prototype.setMainWindowInteractivity.bind({
      mainWindow: win,
    });
    setInteractivity(true);
    setInteractivity(false);
    setInteractivity(true);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
  return win.calls;
};

const INTERACTIVE = { ignore: false, options: undefined };

test("Windows keeps the existing always-interactive behavior", () => {
  assert.deepEqual(hoverCycle("win32"), [INTERACTIVE, INTERACTIVE, INTERACTIVE]);
});

test("Linux native capture fallback does not request unsupported forwarding", () => {
  assert.deepEqual(hoverCycle("linux"), [
    INTERACTIVE,
    { ignore: true, options: undefined },
    INTERACTIVE,
  ]);
});

test("macOS still returns the pill to click-through on mouse-leave", () => {
  assert.deepEqual(hoverCycle("darwin"), [
    INTERACTIVE,
    { ignore: true, options: { forward: true } },
    INTERACTIVE,
  ]);
});

test("a destroyed window is never touched", () => {
  const win = fakeWindow();
  win.isDestroyed = () => true;

  assert.deepEqual(hoverCycle("linux", win), []);
});

test("Linux reports visibility and restores capture only after a failed shape writer settles", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    let visible = false;
    const win = { ...fakeWindow(), isVisible: () => visible, isMinimized: () => false };
    const manager = Object.assign(Object.create(WindowManager.prototype), { mainWindow: win });
    applyInputRegion = async () => undefined;
    assert.equal(await manager.setMainWindowInputRegion(null), false);
    visible = true;
    assert.equal(await manager.setMainWindowInputRegion(null), true);
    let rejectAfterClose;
    applyInputRegion = () =>
      new Promise((_, reject) => {
        rejectAfterClose = reject;
      });
    const applying = manager.setMainWindowInputRegion(null);
    assert.deepEqual(win.calls, []);
    rejectAfterClose(new Error("helper closed"));
    await assert.rejects(applying, /helper closed/);
    assert.deepEqual(win.calls, [INTERACTIVE]);
    win.isDestroyed = () => true;
    assert.equal(await manager.setMainWindowInputRegion(null), false);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("Linux native visibility reports hide, show, minimize and restore to the renderer", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const win = new EventEmitter();
  let visible = true;
  let minimized = false;
  const notifications = [];
  win.isVisible = () => visible;
  win.isMinimized = () => minimized;
  win.webContents = Object.assign(new EventEmitter(), {
    send: (...args) => notifications.push(args),
  });
  try {
    WindowManager.prototype.registerMainWindowEvents.call({
      mainWindow: win,
      enforceMainWindowOnTop: () => {},
    });
    win.emit("ready-to-show");
    visible = false;
    win.emit("hide");
    visible = true;
    win.emit("show");
    minimized = true;
    win.emit("minimize");
    minimized = false;
    win.emit("restore");
    assert.deepEqual(notifications, [
      ["main-window-visibility-changed", false],
      ["main-window-visibility-changed", true],
      ["main-window-visibility-changed", false],
      ["main-window-visibility-changed", true],
    ]);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("a failed Linux keyboard focus request settles quietly", async () => {
  const win = { ...fakeWindow(), isVisible: () => true, isMinimized: () => false };
  const manager = Object.assign(Object.create(WindowManager.prototype), { mainWindow: win });
  let rejectFocus;
  focusInputRegion = () =>
    new Promise((_, reject) => {
      rejectFocus = reject;
    });
  manager._focusLinuxMainWindow();
  // The writer logs its own failure; a rejected request would skip a closing
  // panel's deferred hand-back.
  rejectFocus(new Error("helper closed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager._linuxFocusRequest, null);
});

test("clicks on an unfocused panel share the focus request already in flight", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const win = new EventEmitter();
  win.isFocused = () => false;
  win.isVisible = () => true;
  win.isMinimized = () => false;
  win.isDestroyed = () => false;
  win.webContents = Object.assign(new EventEmitter(), { send: () => undefined });
  const manager = Object.assign(Object.create(WindowManager.prototype), {
    mainWindow: win,
    _assistantPanelOpen: true,
    enforceMainWindowOnTop: () => {},
  });
  const lands = [];
  focusInputRegion = () => new Promise((resolve) => lands.push(resolve));
  const mouseDown = () => win.webContents.emit("input-event", {}, { type: "mouseDown" });
  try {
    WindowManager.prototype.registerMainWindowEvents.call(manager);
    win.emit("ready-to-show");
    mouseDown();
    mouseDown();
    // Each request can wait on the window manager, and queued repeats would
    // run into the helper's timeout, which ends the input region with it.
    assert.equal(lands.length, 1);
    lands[0]();
    await new Promise((resolve) => setImmediate(resolve));
    mouseDown();
    assert.equal(lands.length, 2, "a click after the request landed asks again");
    lands[1]();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("only Linux listens for clicks that re-take keyboard focus", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const [platform, expected] of [
      ["linux", 1],
      ["win32", 0],
      ["darwin", 0],
    ]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const win = new EventEmitter();
      win.isVisible = () => true;
      win.isMinimized = () => false;
      win.webContents = Object.assign(new EventEmitter(), { send: () => undefined });
      WindowManager.prototype.registerMainWindowEvents.call({
        mainWindow: win,
        enforceMainWindowOnTop: () => {},
      });
      win.emit("ready-to-show");
      assert.equal(win.webContents.listenerCount("input-event"), expected, platform);
    }
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("Linux takes keyboard focus again when an unfocused open assistant panel is clicked", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const win = new EventEmitter();
  let focused = false;
  win.isFocused = () => focused;
  win.isVisible = () => true;
  win.isMinimized = () => false;
  win.webContents = Object.assign(new EventEmitter(), { send: () => undefined });
  const focusRequests = [];
  const manager = {
    mainWindow: win,
    _assistantPanelOpen: false,
    enforceMainWindowOnTop: () => {},
    _focusLinuxMainWindow: () => focusRequests.push("focus"),
  };
  const mouseDown = () => win.webContents.emit("input-event", {}, { type: "mouseDown" });
  try {
    WindowManager.prototype.registerMainWindowEvents.call(manager);
    win.emit("ready-to-show");
    mouseDown();
    assert.deepEqual(focusRequests, [], "a pill click must leave the user's app focused");
    manager._assistantPanelOpen = true;
    win.webContents.emit("input-event", {}, { type: "mouseMove" });
    focused = true;
    mouseDown();
    assert.deepEqual(focusRequests, [], "the panel already has the keyboard");
    // Back from another app: the window manager never refocuses the
    // override-redirect pill on a click.
    focused = false;
    mouseDown();
    assert.deepEqual(focusRequests, ["focus"]);
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});
