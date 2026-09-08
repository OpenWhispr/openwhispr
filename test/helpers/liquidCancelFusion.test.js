const test = require("node:test");
const assert = require("node:assert/strict");

// Mirrors of the shared pill contract, pinned against it below so these
// fixtures can never drift from the geometry the component actually renders.
const PILL = { w: 98, h: 36 };
const R = 14;
const GAP = 8;
const SIZE = 28;

test("the fusion fixtures still match the shared pill contract", async () => {
  const { VOICE_PILL_FOOTPRINT, VOICE_PILL_CANCEL } = await import(
    "../../src/helpers/voicePillPresentation.js"
  );
  assert.deepEqual(
    { w: VOICE_PILL_FOOTPRINT.recording.width, h: VOICE_PILL_FOOTPRINT.recording.height },
    PILL
  );
  assert.equal(VOICE_PILL_CANCEL.size, SIZE);
  assert.equal(VOICE_PILL_CANCEL.gap, GAP);
  // The skin's circle radius is half the button; the t=0 tangency proof rests
  // on it (a capsule at least 2R tall swallows the circle exactly).
  assert.equal(R, SIZE / 2);
});

function circleAt(t) {
  return { cx: PILL.w + t * (GAP + SIZE) - SIZE / 2, cy: PILL.h / 2, r: R };
}

function pathPoints(d) {
  return [...d.matchAll(/(-?\d+\.?\d*) (-?\d+\.?\d*)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

test("swallowed cancel (t=0) leaves the pill outline untouched", async () => {
  const { traceFusedOutline, emergenceBlend } = await import(
    "../../src/components/dictation/liquidFusion.ts"
  );
  const out = traceFusedOutline({ pill: PILL, circle: circleAt(0) }, { k: emergenceBlend(0) });
  assert.equal(out.loops, 1);
  const pts = pathPoints(out.d);
  const maxX = Math.max(...pts.map((p) => p.x));
  const minX = Math.min(...pts.map((p) => p.x));
  // the circle is tangent inside the pill's right cap, so the union is the pill
  assert.ok(Math.abs(maxX - PILL.w) < 1.5, `maxX ${maxX} should sit at the pill edge`);
  assert.ok(Math.abs(minX) < 1.5, `minX ${minX} should sit at 0`);
});

test("swallowed cancel stays pill-shaped at in-between footprints", async () => {
  const { traceFusedOutline, emergenceBlend } = await import(
    "../../src/components/dictation/liquidFusion.ts"
  );
  // The skin tweens through these while the pill's own width/height
  // transition runs (40×40 idle ⇄ 98×36 recording), so the t=0 tangency must
  // hold for every in-between capsule, not just the resting footprints.
  for (const pill of [
    { w: 55, h: 39 },
    { w: 69, h: 38 },
    { w: 84, h: 37 },
  ]) {
    const out = traceFusedOutline(
      { pill, circle: { cx: pill.w - R, cy: pill.h / 2, r: R } },
      { k: emergenceBlend(0) }
    );
    assert.equal(out.loops, 1, `pill ${pill.w}×${pill.h} should trace one loop`);
    const pts = pathPoints(out.d);
    const maxX = Math.max(...pts.map((p) => p.x));
    const minX = Math.min(...pts.map((p) => p.x));
    assert.ok(Math.abs(maxX - pill.w) < 1.5, `maxX ${maxX} should sit at the pill edge ${pill.w}`);
    assert.ok(Math.abs(minX) < 1.5, `minX ${minX} should sit at 0`);
  }
});

test("resting cancel (t=1) stays fused to the pill by a single neck", async () => {
  const { traceFusedOutline, emergenceBlend } = await import(
    "../../src/components/dictation/liquidFusion.ts"
  );
  const out = traceFusedOutline({ pill: PILL, circle: circleAt(1) }, { k: emergenceBlend(1) });
  // one loop = the 8px gap is bridged by the smin fillet, not two islands
  assert.equal(out.loops, 1);
  const pts = pathPoints(out.d);
  const maxX = Math.max(...pts.map((p) => p.x));
  assert.ok(
    Math.abs(maxX - (PILL.w + GAP + SIZE)) < 1.5,
    `maxX ${maxX} should reach the cancel button's far edge`
  );
  // vertical symmetry about the shared centerline
  const maxY = Math.max(...pts.map((p) => p.y));
  const minY = Math.min(...pts.map((p) => p.y));
  assert.ok(
    Math.abs(maxY - PILL.h / 2 - (PILL.h / 2 - minY)) < 1,
    `outline should be symmetric about y=${PILL.h / 2} (got ${minY}..${maxY})`
  );
});

test("emergence is monotonic: the outline's reach grows with t", async () => {
  const { traceFusedOutline, emergenceBlend } = await import(
    "../../src/components/dictation/liquidFusion.ts"
  );
  const reach = (t) => {
    const pts = pathPoints(
      traceFusedOutline({ pill: PILL, circle: circleAt(t) }, { k: emergenceBlend(t) }).d
    );
    return Math.max(...pts.map((p) => p.x));
  };
  const r0 = reach(0);
  const rHalf = reach(0.5);
  const r1 = reach(1);
  assert.ok(r0 < rHalf && rHalf < r1, `reach should grow: ${r0} < ${rHalf} < ${r1}`);
});

test("smin degrades to a hard min at k=0", async () => {
  const { smin } = await import("../../src/components/dictation/liquidFusion.ts");
  assert.equal(smin(3, 7, 0), 3);
  assert.equal(smin(-2, 5, 0), -2);
});
