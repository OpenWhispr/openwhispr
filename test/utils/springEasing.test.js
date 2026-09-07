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
