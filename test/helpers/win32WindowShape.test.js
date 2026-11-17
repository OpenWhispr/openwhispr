const test = require("node:test");
const assert = require("node:assert/strict");
const { createWin32WindowShape } = require("../../src/helpers/win32WindowShape");

const PILL = { x: 144, y: 56, width: 64, height: 64, viewportWidth: 208, viewportHeight: 120 };
const PILL_RECT = { x: 144, y: 56, width: 64, height: 64 };

function fakeShapedWindow({ width = 208, height = 120 } = {}) {
  const shapes = [];
  const state = { bounds: { x: 10, y: 20, width, height } };
  const win = { getBounds: () => ({ ...state.bounds }), setShape: (rects) => shapes.push(rects) };
  return { shape: createWin32WindowShape(win), shapes, state };
}

test("a pill region shapes the window to it, and null or an empty region restores the window", () => {
  const { shape, shapes } = fakeShapedWindow();
  shape.set(PILL);
  shape.set(null);
  shape.set(PILL);
  shape.set({ ...PILL, width: 0, height: 0 });
  assert.deepEqual(shapes, [[PILL_RECT], [], [PILL_RECT], []]);
});

test("the full window is restored once, since Chromium repaints on every empty region", () => {
  const { shape, shapes } = fakeShapedWindow();
  shape.set(null);
  shape.set({ ...PILL, width: 0 });
  shape.set(null);
  assert.deepEqual(shapes, [[]]);
});

test("a region measured before a resize restores the full window", () => {
  const { shape, shapes } = fakeShapedWindow();
  shape.set(PILL);
  shape.set({ ...PILL, viewportWidth: 240, viewportHeight: 280 });
  assert.deepEqual(shapes, [[PILL_RECT], []]);
});

test("bounds rounded outward at fractional DPI still match the viewport", () => {
  const { shape, shapes } = fakeShapedWindow({ width: 209, height: 121 });
  shape.set({ ...PILL, x: 144.4, y: 56.6, width: 64.2, height: 63.9 });
  assert.deepEqual(shapes, [[{ x: 144, y: 56, width: 65, height: 65 }]]);
});

test("the shape is clamped to the window", () => {
  const { shape, shapes } = fakeShapedWindow();
  shape.set({ ...PILL, x: -6, y: 100, width: 300, height: 40 });
  assert.deepEqual(shapes, [[{ x: 0, y: 100, width: 208, height: 20 }]]);
});

test("an invalid region throws without touching the shape", () => {
  const { shape, shapes } = fakeShapedWindow();
  assert.throws(() => shape.set({ ...PILL, width: -1 }), /Invalid input region/);
  assert.throws(() => shape.set({ ...PILL, viewportWidth: 0 }), /Invalid input region/);
  assert.deepEqual(shapes, []);
});

test("bounds changes reapply the shape at the same size and restore the window at another", () => {
  const { shape, shapes, state } = fakeShapedWindow();
  shape.set(PILL);
  // A move, possibly onto a display with another scale, and the show nudge.
  state.bounds = { ...state.bounds, x: 2000 };
  shape.revalidate();
  state.bounds.width = 209;
  shape.revalidate();
  assert.deepEqual(shapes, [[PILL_RECT], [PILL_RECT], [PILL_RECT]]);
  state.bounds = { ...state.bounds, width: 240, height: 280 };
  shape.revalidate();
  shape.revalidate();
  assert.deepEqual(shapes.slice(3), [[]]);
});
