const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AGENT_LAYOUT_SIZES,
  clampAgentAnchor,
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
