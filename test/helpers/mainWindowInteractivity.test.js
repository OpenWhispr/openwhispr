const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
let cursorPosition = { x: 0, y: 0 };

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
        getCursorScreenPoint: () => cursorPosition,
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

test("Linux lets transparent padding pass clicks through between pointer-detected hovers", () => {
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

test("native pointer coordinates follow content position and renderer zoom", () => {
  cursorPosition = { x: -660, y: 250 };
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: -800, y: 100, width: 208, height: 120 }),
    webContents: { getZoomFactor: () => 2 },
  };
  const getPointer = () =>
    WindowManager.prototype.getMainWindowPointerPosition.call({ mainWindow: win });

  assert.deepEqual(getPointer(), { x: 70, y: 75 });
  win.getContentBounds = () => ({ x: -700, y: 200, width: 208, height: 120 });
  assert.deepEqual(getPointer(), { x: 20, y: 25 });
});

test("hidden and destroyed windows do not expose a pointer position", () => {
  for (const mainWindow of [
    null,
    { isDestroyed: () => true },
    { isDestroyed: () => false, isVisible: () => false },
    { isDestroyed: () => false, isVisible: () => true, isMinimized: () => true },
  ]) {
    assert.equal(WindowManager.prototype.getMainWindowPointerPosition.call({ mainWindow }), null);
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
  win.webContents = { send: (...args) => notifications.push(args) };
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
