const test = require("node:test");
const assert = require("node:assert/strict");

const { WindowPositionUtil, WINDOW_SIZES } = require("../../src/helpers/windowConfig.js");

// Regression guard for monitor pinning: getMainWindowPosition must floor the widget on
// each display's own work area (workArea.x / workArea.y), never on 0. A naive Math.max(0, x)
// snapped the widget back to the primary monitor whenever the target display had a negative
// origin (a monitor placed left of or above primary).

const { width: W, height: H } = WINDOW_SIZES.BASE;
const MARGIN = 4;
const wa = (x, y, width, height) => ({ workArea: { x, y, width, height } });

test("bottom-right on a monitor left of primary keeps the widget on that monitor (negative x)", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(
    wa(-1920, 0, 1920, 1080),
    null,
    "bottom-right"
  );
  assert.equal(pos.x, -1920 + 1920 - W - MARGIN); // -100, not clamped to 0
  assert.ok(pos.x < 0, "x must stay on the negative-origin monitor, not snap to primary");
  assert.equal(pos.y, 1080 - H - MARGIN);
});

test("center on a monitor left of primary centers within that monitor (negative x)", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(wa(-1920, 0, 1920, 1080), null, "center");
  assert.equal(pos.x, Math.round(-1920 + (1920 - W) / 2)); // -1008
  assert.ok(pos.x < 0);
});

test("bottom-left on a monitor left of primary anchors to that monitor's left edge", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(
    wa(-1920, 0, 1920, 1080),
    null,
    "bottom-left"
  );
  assert.equal(pos.x, -1920 + MARGIN); // -1916
});

test("bottom-right on a monitor above primary keeps the widget on that monitor (negative y)", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(
    wa(0, -1080, 1920, 1080),
    null,
    "bottom-right"
  );
  assert.equal(pos.y, -1080 + 1080 - H - MARGIN); // -100, not clamped to 0
  assert.ok(pos.y < 0, "y must stay on the above-primary monitor, not snap to primary");
});

test("primary with a top panel is unchanged (no regression on the common case)", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(wa(0, 28, 1920, 1020), null, "bottom-right");
  assert.deepEqual(pos, { x: 1920 - W - MARGIN, y: 28 + 1020 - H - MARGIN, width: W, height: H });
});

test("a monitor right of primary lands at a positive x on that monitor", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(
    wa(1920, 0, 1920, 1080),
    null,
    "bottom-right"
  );
  assert.equal(pos.x, 1920 + 1920 - W - MARGIN); // 3740
});

test("falls back to display.bounds when workArea is absent", () => {
  const pos = WindowPositionUtil.getMainWindowPosition(
    { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    null,
    "bottom-right"
  );
  assert.equal(pos.x, -100);
});
