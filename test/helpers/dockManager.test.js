const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Mirrors app.dock: the icon starts visible, as OpenWhispr's does
// (LSUIElement is false), and isVisible() reports what show()/hide() did.
const dock = {
  visible: true,
  calls: [],
  isVisible() {
    return this.visible;
  },
  show() {
    this.calls.push("show");
    this.visible = true;
  },
  hide() {
    this.calls.push("hide");
    this.visible = false;
  },
};

const originalLoad = Module._load;
Module._load = function loadDockManagerWithStubs(request, parent, isMain) {
  if (request === "electron") return { app: { dock } };
  return originalLoad.call(this, request, parent, isMain);
};
const dockManager = require("../../src/helpers/dockManager");
Module._load = originalLoad;

function onPlatform(platform, run) {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  dock.visible = true;
  dock.calls = [];
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
}

test("the Dock icon is only shown or hidden when the control panel changes state", () => {
  onPlatform("darwin", () => {
    dockManager.init();
    dockManager.setControlPanelVisible(true);
    // A second open (Dock-icon click, deep link, Cmd+,) while the panel is up
    // must not show the icon again: on an active app that hands activation to
    // the Dock.
    dockManager.setControlPanelVisible(true);
    dockManager.setControlPanelVisible(false);
    dockManager.setControlPanelVisible(true);

    assert.deepEqual(dock.calls, ["hide", "show", "hide", "show"]);
  });
});

test("the Dock icon is left alone outside macOS", () => {
  for (const platform of ["win32", "linux"]) {
    onPlatform(platform, () => {
      dockManager.init();
      dockManager.setControlPanelVisible(true);
      dockManager.setControlPanelVisible(false);

      assert.deepEqual(dock.calls, []);
    });
  }
});
