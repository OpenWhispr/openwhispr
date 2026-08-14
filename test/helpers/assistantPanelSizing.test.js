const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/assistantPanelSizing.ts");

test("short responses use the compact ratio-preserving panel", async () => {
  const { calculateAssistantPanelSize } = await load();
  assert.deepEqual(calculateAssistantPanelSize(120), {
    surfaceWidth: 360,
    surfaceHeight: 438,
    windowWidth: 384,
    windowHeight: 462,
    isOverflowing: false,
  });
});

test("the reference height produces the exact 442 by 538 surface", async () => {
  const { calculateAssistantPanelSize } = await load();
  assert.deepEqual(calculateAssistantPanelSize(538), {
    surfaceWidth: 442,
    surfaceHeight: 538,
    windowWidth: 466,
    windowHeight: 562,
    isOverflowing: false,
  });
});

test("long responses stop at 600px wide and overflow internally", async () => {
  const { calculateAssistantPanelSize } = await load();
  assert.deepEqual(calculateAssistantPanelSize(2000), {
    surfaceWidth: 600,
    surfaceHeight: 730,
    windowWidth: 624,
    windowHeight: 754,
    isOverflowing: true,
  });
});

test("intermediate sizes stay within one pixel of the reference ratio", async () => {
  const { ASSISTANT_PANEL_RATIO, calculateAssistantPanelSize } = await load();
  const size = calculateAssistantPanelSize(620);
  const expectedHeight =
    (size.surfaceWidth * ASSISTANT_PANEL_RATIO.height) / ASSISTANT_PANEL_RATIO.width;
  assert.ok(Math.abs(size.surfaceHeight - expectedHeight) <= 1);
  assert.ok(size.surfaceHeight >= 620);
  assert.equal(size.isOverflowing, false);
});
