const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/notchDisplay.js");

const notchDisplay = {
  id: 1,
  internal: true,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 37, width: 1512, height: 945 },
};
const plainInternalDisplay = {
  id: 2,
  internal: true,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
};
const externalDisplay = {
  id: 3,
  internal: false,
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1512, y: 25, width: 2560, height: 1415 },
};
// 14 inch panel at the "More Space" scaled resolution (1800 logical wide).
const moreSpaceNotchDisplay = {
  id: 4,
  internal: true,
  bounds: { x: 0, y: 0, width: 1800, height: 1169 },
  workArea: { x: 0, y: 37, width: 1800, height: 1132 },
};

test("findInternalDisplay returns the internal display", async () => {
  const { findInternalDisplay } = await load();
  assert.equal(findInternalDisplay([externalDisplay, notchDisplay]), notchDisplay);
});

test("findInternalDisplay returns null when no display is internal", async () => {
  const { findInternalDisplay } = await load();
  assert.equal(findInternalDisplay([externalDisplay]), null);
});

test("findInternalDisplay returns null for an empty list", async () => {
  const { findInternalDisplay } = await load();
  assert.equal(findInternalDisplay([]), null);
});

test("displayHasNotch is true when the menu bar inset is at least 30px", async () => {
  const { displayHasNotch } = await load();
  assert.equal(displayHasNotch(notchDisplay), true);
});

test("displayHasNotch is false for a standard 25px menu bar", async () => {
  const { displayHasNotch } = await load();
  assert.equal(displayHasNotch(plainInternalDisplay), false);
});

test("displayHasNotch is true exactly at the 30px boundary", async () => {
  const { displayHasNotch } = await load();
  const boundary = { bounds: { x: 0, y: 0 }, workArea: { x: 0, y: 30 } };
  assert.equal(displayHasNotch(boundary), true);
});

test("computeMenuBarHeight returns the inset for a notch Mac", async () => {
  const { computeMenuBarHeight } = await load();
  assert.equal(computeMenuBarHeight(notchDisplay), 37);
});

test("computeMenuBarHeight returns the inset for a standard Mac", async () => {
  const { computeMenuBarHeight } = await load();
  assert.equal(computeMenuBarHeight(plainInternalDisplay), 25);
});

test("computeMenuBarHeight returns 0 for a missing display", async () => {
  const { computeMenuBarHeight } = await load();
  assert.equal(computeMenuBarHeight(null), 0);
  assert.equal(computeMenuBarHeight({}), 0);
});

test("computeMenuBarHeight never returns a negative inset", async () => {
  const { computeMenuBarHeight } = await load();
  const inverted = { bounds: { x: 0, y: 40 }, workArea: { x: 0, y: 10 } };
  assert.equal(computeMenuBarHeight(inverted), 0);
});

test("estimatedNotchWidth returns 200pt at the default 1512 logical width", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth(notchDisplay), 200);
});

test("estimatedNotchWidth scales to 238pt at the 1800 More Space width", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth(moreSpaceNotchDisplay), 238);
});

test("estimatedNotchWidth lands ~229pt for the 16 inch 1728 width", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(
    estimatedNotchWidth({ bounds: { x: 0, y: 0, width: 1728, height: 1117 } }),
    229
  );
});

test("estimatedNotchWidth clamps to the 180pt floor for narrow displays", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth({ bounds: { x: 0, y: 0, width: 1280, height: 800 } }), 180);
});

test("estimatedNotchWidth clamps to the 264pt ceiling for wide displays", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth({ bounds: { x: 0, y: 0, width: 2560, height: 1600 } }), 264);
});

test("computeNotchPopupBounds sizes wings + spacer and pins to the top edge", async () => {
  const { computeNotchPopupBounds } = await load();
  const bounds = computeNotchPopupBounds(notchDisplay, 60);
  // 68 (left) + 200 (spacer) + 48 (right) = 316 wide.
  assert.deepEqual(bounds, { x: 588, y: 0, width: 316, height: 60 });
});

test("computeNotchPopupBounds widens with the spacer at the 1800 width", async () => {
  const { computeNotchPopupBounds } = await load();
  const bounds = computeNotchPopupBounds(moreSpaceNotchDisplay, 60);
  // 68 (left) + 238 (spacer) + 48 (right) = 354 wide.
  assert.deepEqual(bounds, { x: 713, y: 0, width: 354, height: 60 });
});

test("computeNotchPopupBounds centers the spacer midpoint on the display (1512)", async () => {
  const { computeNotchPopupBounds, estimatedNotchWidth, LEFT_WING_WIDTH } = await load();
  const bounds = computeNotchPopupBounds(notchDisplay, 60);
  const spacer = estimatedNotchWidth(notchDisplay);
  const spacerMidpoint = bounds.x + LEFT_WING_WIDTH + spacer / 2;
  const displayMidpoint = notchDisplay.bounds.x + notchDisplay.bounds.width / 2;
  assert.equal(spacerMidpoint, displayMidpoint);
});

test("computeNotchPopupBounds centers the spacer midpoint on the display (1800)", async () => {
  const { computeNotchPopupBounds, estimatedNotchWidth, LEFT_WING_WIDTH } = await load();
  const bounds = computeNotchPopupBounds(moreSpaceNotchDisplay, 60);
  const spacer = estimatedNotchWidth(moreSpaceNotchDisplay);
  const spacerMidpoint = bounds.x + LEFT_WING_WIDTH + spacer / 2;
  const displayMidpoint =
    moreSpaceNotchDisplay.bounds.x + moreSpaceNotchDisplay.bounds.width / 2;
  assert.equal(spacerMidpoint, displayMidpoint);
});

test("computeNotchPopupBounds respects a non-zero display origin", async () => {
  const { computeNotchPopupBounds } = await load();
  const shifted = {
    bounds: { x: 100, y: 50, width: 1512, height: 982 },
    workArea: { x: 100, y: 87, width: 1512, height: 945 },
  };
  const bounds = computeNotchPopupBounds(shifted, 280);
  assert.deepEqual(bounds, { x: 688, y: 50, width: 316, height: 280 });
});

test("resolveNotchPopup returns display and bounds for a notch Mac", async () => {
  const { resolveNotchPopup } = await load();
  const result = resolveNotchPopup([externalDisplay, notchDisplay], { width: 394, height: 60 });
  assert.equal(result.display, notchDisplay);
  assert.deepEqual(result.bounds, { x: 588, y: 0, width: 316, height: 60 });
});

test("resolveNotchPopup returns null when the internal display has no notch", async () => {
  const { resolveNotchPopup } = await load();
  assert.equal(resolveNotchPopup([plainInternalDisplay], { width: 394, height: 60 }), null);
});

test("resolveNotchPopup returns null when there is no internal display (clamshell)", async () => {
  const { resolveNotchPopup } = await load();
  assert.equal(resolveNotchPopup([externalDisplay], { width: 394, height: 60 }), null);
});
