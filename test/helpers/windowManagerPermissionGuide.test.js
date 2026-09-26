const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// WindowManager pulls in electron + sibling managers at require time; only the
// tray-hide path is exercised here.
const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron")
    return {
      app: { on: () => undefined },
      screen: { on: () => undefined },
      BrowserWindow: class {},
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
  if (request === "./dockManager") return { setControlPanelVisible() {} };
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
Module._load = originalLoad;

test("sending the control panel to the tray closes the permission guide explicitly", () => {
  // The guide cannot subscribe to the panel's hide event (occlusion fires it
  // too), so the one real hide path has to tell it.
  const manager = new WindowManager();
  const closes = [];
  manager.permissionGuide = { close: (...args) => closes.push(args) };
  manager.controlPanelWindow = { isDestroyed: () => false, hide: () => undefined };
  manager.hideControlPanelToTray();
  assert.deepEqual(closes, [[false, true]]);
});
