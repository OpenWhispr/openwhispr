const test = require("node:test");
const assert = require("node:assert/strict");

test("dragging a panel's edge away from it widens it, in either direction and layout", async () => {
  const { resizedWidth } = await import("../../src/hooks/useResizableWidth.ts");
  const limits = { min: 180, max: 420 };

  // The notes list's handle is on its end edge: right in left-to-right, left in right-to-left.
  assert.equal(resizedWidth(208, 40, { edge: "end", rtl: false, ...limits }), 248);
  assert.equal(resizedWidth(208, -40, { edge: "end", rtl: true, ...limits }), 248);
  // The docked chat's is on its start edge, so dragging toward the note widens it.
  assert.equal(resizedWidth(400, -60, { edge: "start", rtl: false, ...limits, max: 1200 }), 460);
  assert.equal(resizedWidth(400, 60, { edge: "start", rtl: true, ...limits, max: 1200 }), 460);

  assert.equal(resizedWidth(208, -500, { edge: "end", rtl: false, ...limits }), 180, "no narrower");
  assert.equal(resizedWidth(208, 500, { edge: "end", rtl: false, ...limits }), 420, "no wider");
});
