const test = require("node:test");
const assert = require("node:assert/strict");

const { WindowPositionUtil } = require("../../src/helpers/windowConfig.js");

const display = (id, workArea) => ({ id, bounds: workArea, workArea });

test("main window placement respects displays with negative coordinates", () => {
  const leftDisplay = display(1, { x: -1920, y: 0, width: 1920, height: 1080 });
  const topDisplay = display(2, { x: 0, y: -1200, width: 1920, height: 1200 });

  assert.deepEqual(
    WindowPositionUtil.getMainWindowPosition(leftDisplay, { width: 96, height: 96 }),
    { x: -100, y: 980, width: 96, height: 96 }
  );

  assert.deepEqual(
    WindowPositionUtil.getMainWindowPosition(topDisplay, { width: 96, height: 96 }),
    { x: 1820, y: -100, width: 96, height: 96 }
  );
});

test("reconciliation preserves a visible panel instead of moving it to the cursor display", () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 });
  const secondary = display(2, { x: 1920, y: 0, width: 1920, height: 1080 });
  const currentBounds = { x: 1700, y: 980, width: 96, height: 96 };

  const result = WindowPositionUtil.getReconciledMainWindowBounds(
    currentBounds,
    [primary, secondary],
    secondary,
    "bottom-right"
  );

  assert.equal(result.display.id, primary.id);
  assert.deepEqual(result.bounds, currentBounds);
  assert.equal(result.reason, "visible-clamped");
});

test("reconciliation clamps a partly visible panel into its current display", () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 });
  const cursorDisplay = display(2, { x: 0, y: 1080, width: 1920, height: 1080 });

  const result = WindowPositionUtil.getReconciledMainWindowBounds(
    { x: 1900, y: 1000, width: 96, height: 96 },
    [primary, cursorDisplay],
    cursorDisplay,
    "bottom-right"
  );

  assert.equal(result.display.id, primary.id);
  assert.deepEqual(result.bounds, { x: 1824, y: 984, width: 96, height: 96 });
});

test("reconciliation moves a fully off-screen panel to the cursor display", () => {
  const primary = display(1, { x: 0, y: 0, width: 1920, height: 1080 });
  const cursorDisplay = display(2, { x: 0, y: 1080, width: 1920, height: 1080 });

  const result = WindowPositionUtil.getReconciledMainWindowBounds(
    { x: 3440, y: 980, width: 96, height: 96 },
    [primary, cursorDisplay],
    cursorDisplay,
    "bottom-right"
  );

  assert.equal(result.display.id, cursorDisplay.id);
  assert.deepEqual(result.bounds, { x: 1820, y: 2060, width: 96, height: 96 });
  assert.equal(result.reason, "offscreen-moved-to-cursor-display");
});
