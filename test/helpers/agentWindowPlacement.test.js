const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_LAYOUT_SIZES,
  clampAgentAnchor,
  computeAgentAnchor,
  computeAgentWindowBounds,
} = require("../../src/helpers/agentWindowPlacement");

test("drag limits leave every layout on screen, including small and offset displays", () => {
  for (const workArea of [
    { x: 0, y: 25, width: 1440, height: 875 },
    { x: -1920, y: -1080, width: 1920, height: 1040 },
    { x: 1440, y: 100, width: 800, height: 600 },
    { x: 0, y: 0, width: 320, height: 400 },
  ]) {
    for (const position of [-10000, 10000]) {
      const anchor = clampAgentAnchor({ centerX: position, bottom: position }, workArea);
      for (const layout of Object.keys(AGENT_LAYOUT_SIZES)) {
        const bounds = computeAgentWindowBounds({ anchor, layout, workArea });
        assert.ok(bounds.x >= workArea.x);
        assert.ok(bounds.y >= workArea.y);
        assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
        assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
      }
      assert.ok(
        anchor.bottom - AGENT_LAYOUT_SIZES.pill.height >= workArea.y + workArea.height * 0.6
      );
    }
  }
});

test("a dictation pill lifts the dock only while it is in the dock's lower 40%", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 900 };
  // The 208x120 dictation window dragged from the top to the bottom, and docked
  // while a toast has grown it to 400x500.
  const windows = [
    ...Array.from({ length: 196 }, (_, i) => ({ x: 616, y: i * 4, width: 208, height: 120 })),
    { x: 520, y: 396, width: 400, height: 500 },
  ];
  for (const wholeDictationWindowTakesClicks of [false, true]) {
    for (const dictationBounds of windows) {
      const { bottom } = computeAgentAnchor({
        workArea,
        dictationBounds,
        wholeDictationWindowTakesClicks,
      });
      const pillTop = dictationBounds.y + dictationBounds.height - 52;
      const label = `${wholeDictationWindowTakesClicks} ${JSON.stringify(dictationBounds)}`;
      if (pillTop - 8 < 540 + AGENT_LAYOUT_SIZES.pill.height) {
        // Out of the way: the dock keeps the bottom and its whole drag range.
        assert.equal(bottom, 896, label);
      } else {
        // In the way: above the pill, or on Windows above its whole window.
        const top = wholeDictationWindowTakesClicks ? dictationBounds.y : pillTop;
        assert.ok(bottom <= top - 8, label);
      }
    }
  }
});

test("a call's layouts: its taller pill and cards above it", () => {
  const workArea = { x: 0, y: 0, width: 1512, height: 944 };
  const anchor = { centerX: 756, bottom: 940 };
  const size = (layout, contentHeight) => {
    const { width, height } = computeAgentWindowBounds({
      anchor,
      layout,
      workArea,
      contentHeight,
      call: true,
    });
    return [width, height];
  };
  assert.deepEqual(size("pill"), [256, 81]);
  assert.deepEqual(size("standalone", 182), [466, 182 + 12 + 65 + 16]);
  assert.deepEqual(size("standalone", 900), [466, 520 + 12 + 65 + 16], "a long answer's reference");
});
