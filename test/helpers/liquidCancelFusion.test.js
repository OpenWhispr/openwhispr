const test = require("node:test");
const assert = require("node:assert/strict");

const PILL = { w: 98, h: 36 };
const R = 14;
const GAP = 8;
const SIZE = 28;

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
