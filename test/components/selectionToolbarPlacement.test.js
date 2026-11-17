const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/agent/selectionToolbarPlacement.ts");

const bounds = { top: 56, bottom: 420, left: 0, right: 480 };
const size = { width: 260, height: 40 };

test("the selection toolbar goes below the selection, aligned with its start", async () => {
  const { placeSelectionToolbar } = await load();
  const rect = { top: 200, bottom: 220, left: 20 };
  assert.deepEqual(placeSelectionToolbar({ rect, bounds }, size), { top: 228, left: 20 });
});

test("with no room below, it goes above the selection, never over the composer", async () => {
  const { placeSelectionToolbar } = await load();
  const rect = { top: 380, bottom: 400, left: 20 };
  assert.deepEqual(placeSelectionToolbar({ rect, bounds }, size), { top: 332, left: 20 });
});

test("it stays inside the chat however wide its labels are", async () => {
  const { placeSelectionToolbar } = await load();
  const rect = { top: 200, bottom: 220, left: 400 };
  assert.equal(placeSelectionToolbar({ rect, bounds }, size).left, 212);
  // A selection scrolled partly out of view still keeps the toolbar inside.
  const above = { top: 30, bottom: 410, left: -5 };
  assert.deepEqual(placeSelectionToolbar({ rect: above, bounds }, size), { top: 64, left: 8 });
});
