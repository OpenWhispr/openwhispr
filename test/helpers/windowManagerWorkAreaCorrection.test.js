const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// #1110's desk as Electron reports it under KDE: the 1080p (left) keeps
// workArea == bounds and the primary 4K (right) lost 236 DIP to the other
// monitor's panel. Plasma's answer gives each monitor its own 46 DIP panel.
const DISPLAYS = [
  {
    id: 33,
    bounds: { x: -1, y: 0, width: 1918, height: 1079 },
    workArea: { x: -1, y: 0, width: 1918, height: 1079 },
  },
  {
    id: 35,
    bounds: { x: 1916, y: 0, width: 2256, height: 1269 },
    workArea: { x: 1916, y: 0, width: 2256, height: 1033 },
  },
];
const PLASMA_WORK_AREAS = {
  33: { x: -1, y: 0, width: 1918, height: 1033 },
  35: { x: 1916, y: 0, width: 2256, height: 1223 },
};
const PILL = { width: 211, height: 123 };

let cursor = { x: 0, y: 0 };
let plasmaAnswered = true;
let refreshes = 0;
let workAreasChanged = null;

function distanceTo(rect, point) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function nearestDisplay(point) {
  return DISPLAYS.reduce((best, display) =>
    distanceTo(display.bounds, point) < distanceTo(best.bounds, point) ? display : best
  );
}

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { on: () => undefined },
      screen: {
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: nearestDisplay,
        getDisplayMatching: (rect) =>
          nearestDisplay({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }),
        getPrimaryDisplay: () => DISPLAYS[1],
        on: () => undefined,
      },
      BrowserWindow: class {
        constructor({ x, y, width, height }) {
          this.bounds = { x, y, width, height };
          this.webContents = { on: () => undefined, send: () => undefined };
        }
        isDestroyed() {
          return false;
        }
        getBounds() {
          return this.bounds;
        }
        setBounds(next) {
          this.bounds = next;
        }
      },
      Menu: {},
      shell: {},
      dialog: {},
    };
  }
  if (request === "./plasmaWorkAreas") {
    return {
      plasmaWorkAreas: {
        start: async (onChange) => {
          workAreasChanged = onChange;
        },
        refresh: async () => {
          refreshes += 1;
        },
        resolve: (display) =>
          plasmaAnswered ? { ...display, workArea: PLASMA_WORK_AREAS[display.id] } : display,
      },
    };
  }
  if (request === "./debugLogger")
    return { warn: () => undefined, debug: () => undefined, log: () => undefined };
  if (request === "./hotkeyManager") {
    const FakeHotkeyManager = class {
      unregisterAll() {}
    };
    FakeHotkeyManager.isGlobeLikeHotkey = () => false;
    return FakeHotkeyManager;
  }
  if (request === "./menuManager") return { setupMainMenu: () => undefined };
  if (request === "./devServerManager") return {};
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require("../../src/helpers/windowManager");
const DragManager = require("../../src/helpers/dragManager");
const { WindowPositionUtil } = require("../../src/helpers/windowConfig");
Module._load = originalLoad;

function makeManager(bounds) {
  const manager = new WindowManager();
  const window = {
    bounds,
    setBoundsCalls: 0,
    isDestroyed: () => false,
    getBounds() {
      return this.bounds;
    },
    setBounds(next) {
      this.bounds = next;
      this.setBoundsCalls += 1;
    },
    webContents: { send: () => undefined },
  };
  manager.mainWindow = window;
  manager._notifyMainWindowHorizontalDirection = () => undefined;
  return { manager, window };
}

// Bottom-right anchor: 4 DIP inside the work area's right and bottom edges.
function anchoredOn(workArea) {
  return {
    x: workArea.x + workArea.width - PILL.width - 4,
    y: workArea.y + workArea.height - PILL.height - 4,
    ...PILL,
  };
}

test("showing the pill on another monitor anchors it above that monitor's panel", async () => {
  plasmaAnswered = true;
  refreshes = 0;
  const { manager, window } = makeManager(anchoredOn(DISPLAYS[0].workArea));
  cursor = { x: 3000, y: 600 };

  await manager._repositionToActiveDisplay();

  assert.deepEqual(window.bounds, anchoredOn(PLASMA_WORK_AREAS[35]));
  assert.equal(refreshes, 1, "each show asks Plasma again");
});

test("creating the pill starts watching Plasma, and a change re-anchors it", async () => {
  plasmaAnswered = false;
  cursor = { x: 3000, y: 600 };
  const manager = new WindowManager();
  for (const step of [
    "setMainWindowInteractivity",
    "registerMainWindowEvents",
    "registerAssistantSelectionContextMenu",
    "registerExternalLinkHandlers",
    "loadMainWindow",
    "initializeHotkey",
  ]) {
    manager[step] = async () => undefined;
  }
  manager._notifyMainWindowHorizontalDirection = () => undefined;
  const bottomOf = (bounds) => bounds.y + bounds.height;

  await manager.createMainWindow();
  assert.equal(bottomOf(manager.mainWindow.bounds), DISPLAYS[1].workArea.height - 4);

  plasmaAnswered = true;
  await workAreasChanged();
  assert.equal(bottomOf(manager.mainWindow.bounds), PLASMA_WORK_AREAS[35].height - 4);
});

test("work areas that arrive after placement re-anchor an auto-placed pill", async () => {
  plasmaAnswered = false;
  const placed = WindowPositionUtil.getMainWindowPosition(DISPLAYS[1], PILL, "bottom-right");
  const { manager, window } = makeManager(placed);

  plasmaAnswered = true;
  await manager._reanchorMainWindow();

  assert.deepEqual(window.bounds, anchoredOn(PLASMA_WORK_AREAS[35]));
  await manager._reanchorMainWindow();
  assert.equal(window.setBoundsCalls, 1, "a pill already at its anchor isn't moved again");
});

test("a pill the user dragged keeps its spot when work areas change", async () => {
  plasmaAnswered = true;
  const dragged = { x: 2400, y: 500, ...PILL };
  const { manager, window } = makeManager(dragged);
  manager._mainWindowPlacementCoordinator.markManuallyPositioned();

  await manager._reanchorMainWindow();

  assert.deepEqual(window.bounds, dragged);
  assert.equal(window.setBoundsCalls, 0);
});

test("dragging stops at the monitor's own panel, not at the root work area", () => {
  plasmaAnswered = true;
  const drag = new DragManager();
  const positions = [];
  drag.activeWindow = {
    getBounds: () => anchoredOn(PLASMA_WORK_AREAS[35]),
    setPosition: (x, y) => positions.push({ x, y }),
  };
  drag.dragOffset = { x: 100, y: 60 };
  cursor = { x: 4050, y: 1260 };

  drag.updateWindowPosition();

  assert.deepEqual(positions, [{ x: 3950, y: 1223 - PILL.height }]);
});
