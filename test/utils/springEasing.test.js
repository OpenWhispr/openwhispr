const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/springEasing.ts");

test("a spring samples into a linear() easing that starts at 0 and ends at 1", async () => {
  const { springLinearEasing } = await load();
  const easing = springLinearEasing(300, 26);
  assert.match(easing, /^linear\(/);
  const points = easing.slice("linear(".length, -1).split(", ");
  assert.equal(points.length, 49);
  assert.equal(points[0], "0.0000 0.0%");
  assert.equal(points.at(-1), "1.0000 100.0%");
  // The morph overshoots a little (under-damped) and settles.
  const values = points.map((p) => Number(p.split(" ")[0]));
  assert.ok(Math.max(...values) > 1.0);
  assert.ok(Math.max(...values) < 1.08);
});

test("an over-damped spring never overshoots", async () => {
  const { springLinearEasing } = await load();
  const values = springLinearEasing(520, 46)
    .slice("linear(".length, -1)
    .split(", ")
    .map((p) => Number(p.split(" ")[0]));
  assert.ok(values.every((v) => v <= 1.0));
  for (let i = 1; i < values.length; i++) assert.ok(values[i] >= values[i - 1] - 1e-9);
});

test("the pinned timings and CSS variables match the design page", async () => {
  const { MOTION_TIMING, MOTION_EASING, motionCssVariables } = await load();
  assert.deepEqual(MOTION_TIMING, {
    morphMs: 440,
    showMs: 260,
    zoopMs: 200,
    wordMs: 320,
    wordStaggerMs: 28,
    copyCrossfadeMs: 320,
    companionFadeMs: 160,
    closeFadeMs: 120,
    listeningExpansionMs: 360,
  });
  const vars = motionCssVariables();
  assert.equal(vars["--motion-morph-ease"], MOTION_EASING.morph);
  assert.equal(vars["--motion-morph-ms"], "440ms");
  assert.equal(vars["--motion-zoop-ms"], "200ms");
  assert.equal(vars["--motion-word-stagger-ms"], "28ms");
});

// The tests above (from the task brief) pin the default 48-segment shape and
// the timing/variable table. The two below close gaps a downstream task
// could silently fall through: that the point count actually tracks the
// `segments` argument (not just the hard-coded default), and that damping
// alone — not just "which named spring is this" — is what shapes overshoot.

test("the linear() syntax and stop count scale with the segments argument", async () => {
  const { springLinearEasing } = await load();
  for (const segments of [4, 48]) {
    const easing = springLinearEasing(300, 26, 1, segments);
    const body = easing.match(/^linear\((.+)\)$/);
    assert.ok(body, `not a linear() function: ${easing}`);
    const points = body[1].split(", ");
    assert.equal(points.length, segments + 1);
    for (const point of points) {
      assert.match(point, /^-?\d+\.\d{4} \d+\.\d%$/);
    }
    const percents = points.map((p) => Number(p.split(" ")[1].slice(0, -1)));
    assert.equal(percents[0], 0);
    assert.equal(percents.at(-1), 100);
    for (let i = 1; i < percents.length; i++) assert.ok(percents[i] > percents[i - 1]);
  }
});

test("more damping means less overshoot for the same stiffness (k and c are both load-bearing)", async () => {
  const { springLinearEasing } = await load();
  const maxValue = (stiffness, damping) =>
    Math.max(
      ...springLinearEasing(stiffness, damping)
        .slice("linear(".length, -1)
        .split(", ")
        .map((p) => Number(p.split(" ")[0]))
    );
  const lightlyDamped = maxValue(300, 10);
  const heavilyDamped = maxValue(300, 40);
  assert.ok(lightlyDamped > 1.0, "a lightly damped spring should overshoot");
  assert.ok(
    heavilyDamped < lightlyDamped,
    "heavier damping at the same stiffness must overshoot less"
  );
});

// Fix round 1, finding 1: the zeta >= 1 (critically/over-damped) branch used
// to be a pure function of stiffness and mass — damping only decided WHICH
// branch ran, never shaped the curve once inside it. zoop (k 520, c 46) sits
// just past critical (zeta ~= 1.0086), so a retune of its damping alone used
// to emit a byte-identical easing string. This must no longer be true.
test("damping shapes the over-damped branch too — zoop's own c is not a dead knob", async () => {
  const { springLinearEasing } = await load();
  const zoop = springLinearEasing(520, 46);
  assert.notEqual(springLinearEasing(520, 80), zoop, "retuning c=46 to c=80 must move the curve");
  assert.notEqual(
    springLinearEasing(520, 300),
    zoop,
    "retuning c=46 to c=300 must move the curve further still"
  );
  // And the two heavier-damped retunes must differ from each other too —
  // otherwise the branch could still be secretly collapsing distinct c
  // values onto one curve rather than truly tracking damping continuously.
  assert.notEqual(springLinearEasing(520, 80), springLinearEasing(520, 300));
});

// Fix round 1, finding 5: invalid physical inputs must fail loudly, not
// emit `linear(NaN 0.0%, …)` — an invalid custom-property value is invalid
// AT COMPUTED-VALUE TIME, so CSS silently drops transition-timing-function
// to `ease` with no console error. Silent-wrong-animation is worse than a
// thrown error at the call site (which, for MOTION_EASING, is module load).
test("rejects non-physical inputs instead of silently emitting NaN", async () => {
  const { springLinearEasing } = await load();
  assert.throws(() => springLinearEasing(300, 0), /damping/i);
  assert.throws(() => springLinearEasing(0, 26), /stiffness/i);
  assert.throws(() => springLinearEasing(-10, 26), /stiffness/i);
  assert.throws(() => springLinearEasing(300, -5), /damping/i);
  assert.throws(() => springLinearEasing(300, 26, 0), /mass/i);
  assert.throws(() => springLinearEasing(300, 26, -1), /mass/i);
  assert.throws(() => springLinearEasing(300, 26, 1, 0), /segments/i);
  assert.throws(() => springLinearEasing(300, 26, 1, 4.5), /segments/i);
});

// Fix round 2, finding 2: `!(x > 0)` is false for `Infinity` (Infinity > 0
// is true), so it slipped past the guard above entirely — each call below
// used to return `linear(NaN 0.0%, …)`, the exact silent failure finding 5
// was raised to stop. `-Infinity` was already caught by `> 0` alone; this
// pins the positive-Infinity gap specifically, so the guard means "finite",
// not just "not obviously non-positive".
test("rejects Infinity too, not just non-positive and NaN", async () => {
  const { springLinearEasing } = await load();
  assert.throws(() => springLinearEasing(300, Infinity), /damping/i);
  assert.throws(() => springLinearEasing(Infinity, 26), /stiffness/i);
  assert.throws(() => springLinearEasing(300, 26, Infinity), /mass/i);
  assert.throws(() => springLinearEasing(300, 26, -Infinity), /mass/i);
});

// Fix round 1, finding 2: the plan requires sampling over the spring's
// NATURAL SETTLE TIME and playing the result over the PINNED DURATION —
// never collapsing the two. Nothing above actually proves that: the
// endpoint checks pass no matter what happens in between, and the overshoot
// band (1.0-1.08) is wide enough to swallow a badly wrong middle. This pins
// the curve's actual SHAPE as a regression tripwire. Values computed by
// running this module's own springLinearEasing(300, 26) (morph) — not
// assumed — see the bite-check in the fix-round-1 report for the two
// mutations this specifically catches.
test("morph's curve shape is pinned, not just its endpoints", async () => {
  const { springLinearEasing } = await load();
  const points = springLinearEasing(300, 26)
    .slice("linear(".length, -1)
    .split(", ");
  assert.deepEqual(points.slice(0, 3), ["0.0000 0.0%", "0.0167 2.1%", "0.0605 4.2%"]);
  let peakIndex = 0;
  let peakValue = -Infinity;
  points.forEach((p, i) => {
    const value = Number(p.split(" ")[0]);
    if (value > peakValue) {
      peakValue = value;
      peakIndex = i;
    }
  });
  assert.equal(points[peakIndex], "1.0282 52.1%");
  assert.equal(peakIndex, 25, "the peak must land at stop 25 of 48 (52.1% of the timeline)");
});
