const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Every Dock report and window call lands in one sequence, so the tests can
// assert their relative order. app.dock.show() on an active app hands
// activation to the Dock, and macOS does not give it back: a panel shown
// before the report ends up behind the previously frontmost app's window.
let sequence = [];

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron")
    return {
      app: { on: () => undefined },
      screen: { on: () => undefined },
      BrowserWindow: class {},
      Tray: class {},
      Menu: {},
      nativeImage: {},
      systemPreferences: {},
    };
  if (request === "./debugLogger")
    return { debug() {}, info() {}, warn() {}, error() {}, log() {} };
  if (request === "./hotkeyManager") return class {};
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") return {};
  if (request === "./dockManager")
    return {
      setControlPanelVisible: (visible) => sequence.push(visible ? "dock:visible" : "dock:hidden"),
    };
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  if (request === "./windowConfig")
    return {
      MAIN_WINDOW_CONFIG: {},
      CONTROL_PANEL_CONFIG: {},
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: { COMPACT: {}, EXPANDED: {} },
      WindowPositionUtil: {},
    };
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

// A control panel that is hidden to the tray, minimized, or open. Restoring a
// minimized window also shows it, as it does in Electron.
function createControlPanel({ visible: initiallyVisible = false, minimized = false } = {}) {
  let visible = initiallyVisible;
  let isMinimized = minimized;
  return {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => isMinimized,
    restore() {
      sequence.push("restore");
      isMinimized = false;
      visible = true;
    },
    show() {
      sequence.push("show");
      visible = true;
    },
    focus() {
      sequence.push("focus");
    },
    on: () => undefined,
    webContents: { isCrashed: () => false },
  };
}

function createManagers() {
  sequence = [];
  const windowManager = new WindowManager();
  const trayManager = new TrayManager();
  trayManager.setWindowManager(windowManager);
  return { windowManager, trayManager };
}

test("reopening a hidden control panel reports the Dock before showing the window", async () => {
  const { windowManager } = createManagers();
  windowManager.controlPanelWindow = createControlPanel();

  await windowManager.createControlPanelWindow();

  assert.deepEqual(sequence, ["dock:visible", "show", "focus"]);
});

test("restoring a minimized control panel reports the Dock before restoring the window", () => {
  const { windowManager } = createManagers();
  windowManager.controlPanelWindow = createControlPanel({ minimized: true });

  windowManager.showControlPanel();

  assert.deepEqual(sequence, ["dock:visible", "restore", "show", "focus"]);
});

test("a control panel open behind another app is shown again, not only focused", () => {
  // On macOS show() activates the app even while another app is active, and
  // focus() does not: a deep link arrives while the browser is frontmost.
  const { windowManager } = createManagers();
  windowManager.controlPanelWindow = createControlPanel({ visible: true });

  windowManager.showControlPanel();

  assert.deepEqual(sequence, ["dock:visible", "show", "focus"]);
});

test("the first show of a new control panel reports the Dock before showing the window", () => {
  const { windowManager } = createManagers();
  windowManager.controlPanelWindow = createControlPanel();

  windowManager._showControlPanel();

  assert.deepEqual(sequence, ["dock:visible", "show", "focus"]);
});

test("opening a hidden control panel from the tray reports the Dock before showing the window", async () => {
  const { windowManager, trayManager } = createManagers();
  windowManager.controlPanelWindow = createControlPanel();

  await trayManager.toggleControlPanelFromTray();

  assert.deepEqual(sequence, ["dock:visible", "show", "focus"]);
});

test("opening a minimized control panel from the tray reports the Dock before restoring the window", async () => {
  const { windowManager, trayManager } = createManagers();
  windowManager.controlPanelWindow = createControlPanel({ minimized: true });

  await trayManager.toggleControlPanelFromTray();

  assert.deepEqual(sequence, ["dock:visible", "restore", "show", "focus"]);
});

test("opening the tray after the control panel was destroyed reports the Dock before showing the new window", async () => {
  const { windowManager, trayManager } = createManagers();
  trayManager.setCreateControlPanelCallback(async () => {
    windowManager.controlPanelWindow = createControlPanel();
  });

  await trayManager.toggleControlPanelFromTray();

  assert.deepEqual(sequence, ["dock:visible", "show", "focus"]);
});
