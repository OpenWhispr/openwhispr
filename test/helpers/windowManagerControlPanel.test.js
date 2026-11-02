const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const dockVisibilityCalls = [];

const originalLoad = Module._load;
Module._load = function loadWindowManagerWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getDisplayMatching: () => ({
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
        }),
      },
    };
  }
  if (request === "./debugLogger") return {};
  if (request === "./hotkeyManager") return class {};
  if (request === "./dragManager") return class {};
  if (request === "./menuManager") return {};
  if (request === "./devServerManager") return {};
  if (request === "./dockManager") {
    return {
      setControlPanelVisible: (visible) => dockVisibilityCalls.push(visible),
    };
  }
  if (request === "./i18nMain") return { i18nMain: {} };
  if (request === "./windowConfig") {
    return {
      NOTIFICATION_WINDOW_CONFIG: {},
      WINDOW_SIZES: { BASE: { width: 96, height: 96 } },
      ONBOARDING_WINDOW_SIZES: {
        COMPACT: { width: 480, height: 624 },
        EXPANDED: { width: 1000, height: 740 },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
Module._load = originalLoad;

function createControlPanelWindow({
  visible,
  bounds = { x: 120, y: 90, width: 1200, height: 800 },
}) {
  const calls = [];
  let currentBounds = { ...bounds };
  let isVisible = visible;

  return {
    calls,
    isVisible: () => isVisible,
    window: {
      isDestroyed: () => false,
      isVisible: () => isVisible,
      isFullScreen: () => false,
      isMaximized: () => false,
      isMinimized: () => false,
      getBounds: () => ({ ...currentBounds }),
      getContentBounds: () => ({ ...currentBounds }),
      setContentBounds: (nextBounds) => {
        currentBounds = { ...nextBounds };
        calls.push("setContentBounds");
      },
      isResizable: () => true,
      isMinimizable: () => true,
      isMaximizable: () => true,
      isClosable: () => true,
      isFullScreenable: () => true,
      getMinimumSize: () => [400, 300],
      setResizable: () => undefined,
      setMinimizable: () => undefined,
      setMaximizable: () => undefined,
      setClosable: () => undefined,
      setFullScreenable: () => undefined,
      setMinimumSize: () => undefined,
      setWindowButtonVisibility: () => undefined,
      show: () => {
        isVisible = true;
        calls.push("show");
      },
      focus: () => calls.push("focus"),
      hide: () => {
        isVisible = false;
        calls.push("hide");
      },
    },
  };
}

function createManager(windowOptions) {
  const manager = new WindowManager();
  const fake = createControlPanelWindow(windowOptions);
  manager.controlPanelWindow = fake.window;
  return { manager, ...fake };
}

test.beforeEach(() => {
  dockVisibilityCalls.length = 0;
});

test("initial restore still reveals the renderer-sized control panel", () => {
  const { manager, calls, isVisible } = createManager({ visible: false });
  manager._controlPanelVisibilityTimer = 1;

  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.equal(isVisible(), true);
  assert.deepEqual(calls, ["show", "focus"]);
  assert.deepEqual(dockVisibilityCalls, [true]);
});

test("repeated restore preserves a control panel hidden to the tray", () => {
  const { manager, calls, isVisible } = createManager({ visible: true });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  assert.equal(manager.setOnboardingWindowMode("restore"), true);

  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);
});

test("compact reauthentication can resize a tray-hidden panel without surfacing it", () => {
  const { manager, calls, isVisible } = createManager({ visible: true });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  assert.equal(manager.setOnboardingWindowMode("compact"), true);

  assert.equal(isVisible(), false);
  assert.deepEqual(calls, ["setContentBounds"]);
  assert.deepEqual(dockVisibilityCalls, []);
});

test("repeated compact resends keep a tray-hidden panel hidden", () => {
  // Already at the centered compact bounds, so no resize is needed.
  const { manager, calls, isVisible } = createManager({
    visible: true,
    bounds: { x: 480, y: 138, width: 480, height: 624 },
  });
  manager._controlPanelVisibilityTimer = 1;
  manager.hideControlPanelToTray();
  calls.length = 0;
  dockVisibilityCalls.length = 0;

  // First resend: bounds already match the target.
  assert.equal(manager.setOnboardingWindowMode("compact"), true);
  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);

  // Second resend: the mode is already compact.
  assert.equal(manager.setOnboardingWindowMode("compact"), true);
  assert.equal(isVisible(), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(dockVisibilityCalls, []);
});
