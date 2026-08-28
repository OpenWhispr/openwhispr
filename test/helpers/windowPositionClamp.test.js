const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveHorizontalWindowDirection,
  WindowPositionUtil,
} = require("../../src/helpers/windowConfig");

// A 1512px laptop screen with a wider monitor mounted above it: x beyond 1512
// is dead space at the laptop's y range, even though the desktop spans further.
const LAPTOP = { workArea: { x: 0, y: 0, width: 1512, height: 949 } };

test("voice direction follows the overlay's actual half of the display", () => {
  assert.equal(
    resolveHorizontalWindowDirection({ x: 4, width: 96 }, LAPTOP, "bottom-right"),
    "left"
  );
  assert.equal(
    resolveHorizontalWindowDirection({ x: 1412, width: 96 }, LAPTOP, "bottom-left"),
    "right"
  );
});

test("center and unavailable geometry retain the established preference fallback", () => {
  assert.equal(
    resolveHorizontalWindowDirection({ x: 708, width: 96 }, LAPTOP, "bottom-left"),
    "left"
  );
  assert.equal(
    resolveHorizontalWindowDirection({ x: 708, width: 96 }, LAPTOP, "bottom-right"),
    "right"
  );
  assert.equal(resolveHorizontalWindowDirection(null, null, "bottom-left"), "left");
  assert.equal(resolveHorizontalWindowDirection(null, null, "bottom-right"), "right");
  assert.equal(resolveHorizontalWindowDirection({ x: 4, width: 96 }, LAPTOP, "center"), "right");
});

test("pulls a window parked beyond a display edge back into its work area", () => {
  const stranded = { x: 1472, y: 33, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(stranded, LAPTOP), { x: 1416, y: 33 });
});

test("leaves a window already inside the work area untouched", () => {
  const inside = { x: 1412, y: 849, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(inside, LAPTOP), { x: 1412, y: 849 });
});

// A monitor mounted above (or left of) the primary display has a negative origin
// in Electron's coordinate space. Flooring a computed position at zero lands the
// window on a row that display doesn't cover — beside the primary screen, where
// nothing is drawn and the overlay looks like it vanished.
const MONITOR_ABOVE = { workArea: { x: -451, y: -1440, width: 2560, height: 1440 } };

test("the panel lands on a monitor mounted above the primary display", () => {
  const position = WindowPositionUtil.getMainWindowPosition(MONITOR_ABOVE, null, "bottom-right");

  assert.deepEqual(position, { x: 1929, y: -124, width: 176, height: 120 });
  assert.ok(position.y < 0, "a display above the primary one needs a negative y");
});

test("every panel anchor stays inside a negative-origin display", () => {
  for (const anchor of ["bottom-right", "bottom-left", "center"]) {
    const { x, y, width, height } = WindowPositionUtil.getMainWindowPosition(
      MONITOR_ABOVE,
      null,
      anchor
    );
    const { workArea } = MONITOR_ABOVE;
    assert.ok(x >= workArea.x && x + width <= workArea.x + workArea.width, `${anchor} x`);
    assert.ok(y >= workArea.y && y + height <= workArea.y + workArea.height, `${anchor} y`);
  }
});

test("the meeting prompt also lands on a monitor above the primary display", () => {
  const { x, y, width, height } = WindowPositionUtil.getNotificationPosition(MONITOR_ABOVE);
  const { workArea } = MONITOR_ABOVE;

  assert.ok(y < 0, "the prompt must not be floored onto the primary display's rows");
  assert.ok(x >= workArea.x && x + width <= workArea.x + workArea.width);
  assert.ok(y >= workArea.y && y + height <= workArea.y + workArea.height);
});

test("a window larger than its display is pinned to the work area origin", () => {
  const tiny = { workArea: { x: 0, y: 25, width: 800, height: 600 } };
  const position = WindowPositionUtil.getMainWindowPosition(tiny, { width: 900, height: 700 });

  assert.equal(position.x, 0);
  assert.equal(position.y, 25);
});

test("clamps against negative-origin displays and falls back to bounds", () => {
  const external = { bounds: { x: -451, y: -1440, width: 2560, height: 1440 } };
  assert.deepEqual(
    WindowPositionUtil.clampToWorkArea({ x: -900, y: -2000, width: 400, height: 500 }, external),
    { x: -451, y: -1440 }
  );
});
