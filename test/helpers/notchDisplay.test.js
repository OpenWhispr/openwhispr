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
// 16 inch panel at its default resolution (1728 logical, 3456 physical wide).
const sixteenInchNotchDisplay = {
  id: 5,
  internal: true,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  workArea: { x: 0, y: 37, width: 1728, height: 1080 },
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

test("estimatedNotchWidth returns 186pt at the default 1512 logical width", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth(notchDisplay), 186);
});

test("estimatedNotchWidth scales to 221pt at the 1800 More Space width", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth(moreSpaceNotchDisplay), 221);
});

test("estimatedNotchWidth lands 200pt for the 16 inch panel via scaleFactor", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(estimatedNotchWidth(sixteenInchNotchDisplay), 200);
});

test("estimatedNotchWidth does not match the 16 inch panel for the MBA 15 inch (physical 3420)", async () => {
  const { estimatedNotchWidth } = await load();
  // 1710 * 2 = 3420 is 36px off the 3456 entry (> 32 tolerance), so it falls back to the ratio.
  // Ratio path 1710 * 0.1228 = 210; a 16" match (0.1157) would give 198.
  assert.equal(
    estimatedNotchWidth({ scaleFactor: 2, bounds: { x: 0, y: 0, width: 1710, height: 1112 } }),
    210
  );
});

test("estimatedNotchWidth uses the 14 inch panel ratio when scaleFactor identifies it", async () => {
  const { estimatedNotchWidth } = await load();
  assert.equal(
    estimatedNotchWidth({ scaleFactor: 2, bounds: { x: 0, y: 0, width: 1512, height: 982 } }),
    186
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

test("computeNotchPopupBounds centers the fixed window and pins to the top edge", async () => {
  const { computeNotchPopupBounds } = await load();
  const bounds = computeNotchPopupBounds(notchDisplay, { width: 640, height: 360 });
  // 1512/2 - 640/2 = 436.
  assert.deepEqual(bounds, { x: 436, y: 0, width: 640, height: 360 });
});

test("computeNotchPopupBounds centers the window midpoint on the display", async () => {
  const { computeNotchPopupBounds } = await load();
  const bounds = computeNotchPopupBounds(moreSpaceNotchDisplay, { width: 640, height: 360 });
  const midpoint = bounds.x + bounds.width / 2;
  const displayMidpoint =
    moreSpaceNotchDisplay.bounds.x + moreSpaceNotchDisplay.bounds.width / 2;
  assert.ok(Math.abs(midpoint - displayMidpoint) <= 0.5);
});

test("computeNotchPopupBounds respects a non-zero display origin", async () => {
  const { computeNotchPopupBounds } = await load();
  const shifted = {
    bounds: { x: 100, y: 50, width: 1512, height: 982 },
    workArea: { x: 100, y: 87, width: 1512, height: 945 },
  };
  const bounds = computeNotchPopupBounds(shifted, { width: 640, height: 360 });
  assert.deepEqual(bounds, { x: 536, y: 50, width: 640, height: 360 });
});

test("resolveNotchPopup returns display and bounds for a notch Mac", async () => {
  const { resolveNotchPopup } = await load();
  const result = resolveNotchPopup([externalDisplay, notchDisplay], { width: 640, height: 360 });
  assert.equal(result.display, notchDisplay);
  assert.deepEqual(result.bounds, { x: 436, y: 0, width: 640, height: 360 });
});

test("resolveNotchPopup returns null when the internal display has no notch", async () => {
  const { resolveNotchPopup } = await load();
  assert.equal(resolveNotchPopup([plainInternalDisplay], { width: 394, height: 60 }), null);
});

test("resolveNotchPopup returns null when there is no internal display (clamshell)", async () => {
  const { resolveNotchPopup } = await load();
  assert.equal(resolveNotchPopup([externalDisplay], { width: 394, height: 60 }), null);
});

test("setMeasuredNotchWidths overrides the heuristic on an exact width/height match", async () => {
  const { estimatedNotchWidth, setMeasuredNotchWidths, clearMeasuredNotchWidths } = await load();
  try {
    // Heuristic would return 186 for this 1512x982 display; probe measured 199.
    setMeasuredNotchWidths([{ width: 1512, height: 982, notchWidth: 199.4, menuBarInset: 38 }]);
    assert.equal(estimatedNotchWidth(notchDisplay), 199);
  } finally {
    clearMeasuredNotchWidths();
  }
});

test("estimatedNotchWidth falls back to the heuristic when measured size does not match", async () => {
  const { estimatedNotchWidth, setMeasuredNotchWidths, clearMeasuredNotchWidths } = await load();
  try {
    // Measured entry is for a different display (1728x1117), so the 1512 display uses the heuristic.
    setMeasuredNotchWidths([{ width: 1728, height: 1117, notchWidth: 200, menuBarInset: 38 }]);
    assert.equal(estimatedNotchWidth(notchDisplay), 186);
  } finally {
    clearMeasuredNotchWidths();
  }
});

test("estimatedNotchWidth falls back to the heuristic when measured notchWidth is 0", async () => {
  const { estimatedNotchWidth, setMeasuredNotchWidths, clearMeasuredNotchWidths } = await load();
  try {
    // A non-notch screen measures notchWidth 0, which must not override the heuristic.
    setMeasuredNotchWidths([{ width: 1512, height: 982, notchWidth: 0, menuBarInset: 0 }]);
    assert.equal(estimatedNotchWidth(notchDisplay), 186);
  } finally {
    clearMeasuredNotchWidths();
  }
});

test("clearMeasuredNotchWidths restores heuristic behaviour", async () => {
  const { estimatedNotchWidth, setMeasuredNotchWidths, clearMeasuredNotchWidths } = await load();
  setMeasuredNotchWidths([{ width: 1512, height: 982, notchWidth: 199, menuBarInset: 38 }]);
  assert.equal(estimatedNotchWidth(notchDisplay), 199);
  clearMeasuredNotchWidths();
  assert.equal(estimatedNotchWidth(notchDisplay), 186);
});
