const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dockPolicy.js");

test("the Dock icon follows the control panel", async () => {
  const { resolveDockVisibility } = await load();

  assert.equal(resolveDockVisibility({ platform: "darwin", controlPanelVisible: true }), true);
  assert.equal(resolveDockVisibility({ platform: "darwin", controlPanelVisible: false }), false);
});

test("hiding the dictation panel cannot resurrect the Dock icon", async () => {
  const { resolveDockVisibility } = await load();

  // Regression guard for #428: the auto-hide-when-idle cycle ended every
  // dictation with an app.dock.show(), a leftover from when the macOS branch
  // minimized the panel into the Dock instead of hiding it. The dictation panel
  // is not the control panel, so it cannot affect the icon either way.
  assert.equal(resolveDockVisibility({ platform: "darwin", controlPanelVisible: false }), false);
});

test("there is no Dock to act on outside macOS", async () => {
  const { resolveDockVisibility } = await load();

  for (const platform of ["win32", "linux"]) {
    assert.equal(resolveDockVisibility({ platform, controlPanelVisible: true }), null);
  }
});
