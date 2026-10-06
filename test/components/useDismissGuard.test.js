const test = require("node:test");
const assert = require("node:assert/strict");

async function loadGuard() {
  const mod = await import("../../src/components/ui/useDismissGuard.ts");
  return mod.hasLayerAbove ?? mod.default.hasLayerAbove;
}

// A stand-in for the dialog's own content node. Radix writes `pointer-events`
// inline on it, so the style bag is all the probe reads.
function contentNode(pointerEvents) {
  return { style: { pointerEvents } };
}

function probe({ popper = false, openDialogs = [] } = {}) {
  return {
    querySelector: (sel) => (sel === "[data-radix-popper-content-wrapper]" && popper ? {} : null),
    querySelectorAll: () => openDialogs,
  };
}

test("nothing above the dialog is not a layer", async () => {
  const hasLayerAbove = await loadGuard();
  const content = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [content] })), false);
});

test("an inert content node means a layer above disabled its pointer events", async () => {
  const hasLayerAbove = await loadGuard();
  // This is the Select-open case: Radix sets `pointer-events: none` on the
  // dialog content, so the click that dismisses the Select lands on the
  // dialog's own overlay instead of on the panel the user aimed at.
  const content = contentNode("none");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [content] })), true);
});

test("a mounted radix popper is a layer above", async () => {
  const hasLayerAbove = await loadGuard();
  const content = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ popper: true, openDialogs: [content] })), true);
});

test("a dialog opened later stacks above this one", async () => {
  const hasLayerAbove = await loadGuard();
  const content = contentNode("auto");
  const stacked = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [content, stacked] })), true);
});

test("the topmost open dialog has nothing above it", async () => {
  const hasLayerAbove = await loadGuard();
  const below = contentNode("auto");
  const content = contentNode("auto");
  assert.equal(hasLayerAbove(content, probe({ openDialogs: [below, content] })), false);
});

test("an unmounted content node reports no layer above", async () => {
  const hasLayerAbove = await loadGuard();
  assert.equal(hasLayerAbove(null, probe()), false);
});
