const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
let applyInputRegion;
let cursorPoint = { x: 0, y: 0 };

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
        getCursorScreenPoint: () => cursorPoint,
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

test("Windows captures clicks only while the cursor is over the reported pill region", async (t) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", original));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const win = {
    ...fakeWindow(),
    isVisible: () => true,
    isMinimized: () => false,
    // A 208x120 pill window parked in the bottom-right corner of 1920x1032.
    getContentBounds: () => ({ x: 1708, y: 908, width: 208, height: 120 }),
  };
  const manager = Object.assign(Object.create(WindowManager.prototype), { mainWindow: win });
  const region = { x: 156, y: 68, width: 40, height: 40, viewportWidth: 208, viewportHeight: 120 };

  // Cursor over another app's button inside the invisible part of the window.
  cursorPoint = { x: 1720, y: 920 };
  assert.equal(await manager.setMainWindowInputRegion(region), true);
  assert.deepEqual(win.calls, [{ ignore: true, options: undefined }]);

  // Hovering the pill takes clicks again on the next poll.
  cursorPoint = { x: 1884, y: 996 };
  t.mock.timers.tick(30);
  assert.deepEqual(win.calls.at(-1), INTERACTIVE);

  // Unchanged state is not re-applied every tick.
  t.mock.timers.tick(90);
  assert.equal(win.calls.length, 2);

  // A menu, toast or drag reports a null region: the whole window captures,
  // even with the cursor outside the pill, and polling stops.
  cursorPoint = { x: 1720, y: 920 };
  await manager.setMainWindowInputRegion(null);
  t.mock.timers.tick(90);
  assert.equal(win.calls.length, 2);

  manager._stopWin32HitTest();
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

test("Windows nudges the pill's size on every show so button presses reach it again", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const [platform, expected] of [
      ["win32", 2],
      ["darwin", 0],
      ["linux", 0],
    ]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      const bounds = { x: 1708, y: 908, width: 208, height: 120 };
      const setBounds = [];
      const win = new EventEmitter();
      win.isDestroyed = () => false;
      win.isVisible = () => true;
      win.isMinimized = () => false;
      win.getBounds = () => ({ ...bounds });
      win.getMinimumSize = () => [bounds.width, bounds.height];
      win.setBounds = (next) => setBounds.push(next);
      win.webContents = Object.assign(new EventEmitter(), { send: () => undefined });
      const manager = Object.assign(Object.create(WindowManager.prototype), {
        mainWindow: win,
        enforceMainWindowOnTop: () => {},
      });
      WindowManager.prototype.registerMainWindowEvents.call(manager);
      win.emit("ready-to-show");
      win.emit("show");
      assert.equal(setBounds.length, expected, platform);
      if (expected) {
        // The size changes for one call and always ends where it started.
        assert.deepEqual(setBounds, [{ ...bounds, width: 209 }, bounds]);
      }
    }
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

for (const { scaleFactor, size, nativeBounds } of [
  {
    scaleFactor: 1.25,
    size: [208, 120],
    nativeBounds: { x: 126, y: 126, width: 260, height: 150 },
  },
  { scaleFactor: 1.5, size: [208, 120], nativeBounds: { x: 152, y: 152, width: 312, height: 180 } },
  {
    scaleFactor: 1.75,
    size: [208, 120],
    nativeBounds: { x: 177, y: 177, width: 364, height: 210 },
  },
  {
    scaleFactor: 1.25,
    size: [333, 137],
    nativeBounds: { x: -126, y: -126, width: 417, height: 172 },
  },
  {
    scaleFactor: 1.5,
    size: [333, 137],
    nativeBounds: { x: -152, y: -152, width: 500, height: 206 },
  },
  {
    scaleFactor: 1.75,
    size: [333, 137],
    nativeBounds: { x: -177, y: -177, width: 583, height: 240 },
  },
]) {
  test(`Windows preserves native bounds over repeated shows at ${scaleFactor * 100}% (${size.join("x")})`, () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      let currentNativeBounds = { ...nativeBounds };
      let minimumSize = [...size];
      const resizedBounds = [];
      const roundPoint = (value) => Math.sign(value) * Math.round(Math.abs(value));
      const inverseScale = Math.fround(1 / scaleFactor);
      const win = new EventEmitter();
      win.isDestroyed = () => false;
      win.isVisible = () => true;
      win.isMinimized = () => false;
      // ScreenWin rounds the origin but encloses both screen-space edges for
      // size. Fixed-size HWND constraints instead retain the requested DIP size.
      win.getBounds = () => {
        const { x, y, width, height } = currentNativeBounds;
        return {
          x: roundPoint(Math.fround(x * inverseScale)),
          y: roundPoint(Math.fround(y * inverseScale)),
          width:
            Math.ceil(Math.fround((x + width) * inverseScale)) -
            Math.floor(Math.fround(x * inverseScale)),
          height:
            Math.ceil(Math.fround((y + height) * inverseScale)) -
            Math.floor(Math.fround(y * inverseScale)),
        };
      };
      win.getMinimumSize = () => [...minimumSize];
      win.setBounds = ({ x, y, width, height }) => {
        minimumSize = [width, height];
        currentNativeBounds = {
          x: roundPoint(x * scaleFactor),
          y: roundPoint(y * scaleFactor),
          width: Math.ceil(width * scaleFactor),
          height: Math.ceil(height * scaleFactor),
        };
        resizedBounds.push(currentNativeBounds);
      };
      win.webContents = Object.assign(new EventEmitter(), { send: () => undefined });
      const manager = Object.assign(Object.create(WindowManager.prototype), {
        mainWindow: win,
        enforceMainWindowOnTop: () => {},
      });
      manager.registerMainWindowEvents();
      win.emit("ready-to-show");

      for (let cycle = 0; cycle < 10; cycle++) {
        win.emit("hide");
        win.emit("show");
        assert.deepEqual(currentNativeBounds, nativeBounds, `show ${cycle + 1}`);
        assert.ok(
          Math.ceil(Math.fround(resizedBounds.at(-2).width * inverseScale)) >
            Math.ceil(Math.fround(nativeBounds.width * inverseScale)),
          "nudge changes the renderer's DIP width"
        );
        assert.deepEqual(minimumSize, size);
      }
      assert.equal(resizedBounds.length, 20);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
}
