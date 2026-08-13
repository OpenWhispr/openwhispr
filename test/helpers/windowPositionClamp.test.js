const test = require("node:test");
const assert = require("node:assert/strict");

const { WindowPositionUtil } = require("../../src/helpers/windowConfig");

// A 1512px laptop screen with a wider monitor mounted above it: x beyond 1512
// is dead space at the laptop's y range, even though the desktop spans further.
const LAPTOP = { workArea: { x: 0, y: 0, width: 1512, height: 949 } };

test("pulls a window parked beyond a display edge back into its work area", () => {
  const stranded = { x: 1472, y: 33, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(stranded, LAPTOP), { x: 1416, y: 33 });
});

test("leaves a window already inside the work area untouched", () => {
  const inside = { x: 1412, y: 849, width: 96, height: 96 };
  assert.deepEqual(WindowPositionUtil.clampToWorkArea(inside, LAPTOP), { x: 1412, y: 849 });
});

test("clamps against negative-origin displays and falls back to bounds", () => {
  const external = { bounds: { x: -451, y: -1440, width: 2560, height: 1440 } };
  assert.deepEqual(
    WindowPositionUtil.clampToWorkArea({ x: -900, y: -2000, width: 400, height: 500 }, external),
    { x: -451, y: -1440 }
  );
});
