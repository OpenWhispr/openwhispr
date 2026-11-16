const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/permissionGuidePlacement.js");

const workArea = { x: 0, y: 0, width: 1512, height: 944 };
const size = { width: 560, height: 124 };

test("the overlay sits inside the bottom edge of the System Settings window", async () => {
  const { computeGuideBounds } = await load();

  const bounds = computeGuideBounds({
    settingsBounds: { x: 232, y: 232, width: 723, height: 504 },
    workArea,
    size,
  });

  assert.equal(bounds.x, 314);
  assert.equal(bounds.y, 592);
  assert.equal(bounds.width, 560);
  assert.equal(bounds.height, 124);
});

test("without a System Settings window it falls back to the bottom of the display", async () => {
  const { computeGuideBounds } = await load();

  const bounds = computeGuideBounds({ settingsBounds: null, workArea, size });

  assert.equal(bounds.x, 476);
  assert.equal(bounds.y, 796);
});

test("a tall System Settings window cannot push the overlay off screen", async () => {
  const { computeGuideBounds } = await load();

  // The real window measured during onboarding: 723x804 at y 232 ends at 1036,
  // past the bottom of a 944pt work area, so the inset spot is off screen too.
  const bounds = computeGuideBounds({
    settingsBounds: { x: 232, y: 232, width: 723, height: 804 },
    workArea,
    size,
  });

  assert.equal(bounds.y, 796);
  assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
});

test("a System Settings window near a screen edge keeps the overlay fully visible", async () => {
  const { computeGuideBounds } = await load();

  const bounds = computeGuideBounds({
    settingsBounds: { x: 1300, y: 100, width: 700, height: 400 },
    workArea,
    size,
  });

  assert.ok(bounds.x >= workArea.x);
  assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
});

test("placement is relative to the display the window is on, not the primary one", async () => {
  const { computeGuideBounds } = await load();
  const external = { x: -2560, y: -200, width: 2560, height: 1440 };

  const bounds = computeGuideBounds({ settingsBounds: null, workArea: external, size });

  assert.equal(bounds.x, -1560);
  assert.equal(bounds.y, 1092);
});

test("an overlay wider than the display is trimmed to fit", async () => {
  const { computeGuideBounds } = await load();
  const narrow = { x: 0, y: 0, width: 400, height: 500 };

  const bounds = computeGuideBounds({ settingsBounds: null, workArea: narrow, size });

  assert.equal(bounds.width, 400);
  assert.equal(bounds.x, 0);
});
