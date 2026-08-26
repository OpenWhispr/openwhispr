const test = require("node:test");
const assert = require("node:assert/strict");
const { renderStatic } = require("../helpers/harness/reactSsr");

const loadMath = () => import("../../src/components/ui/liveWaveformMath.ts");
const loadComponent = () => import("../../src/components/ui/LiveWaveform.tsx");

test("bar color is fixed per index: a gradient from periwinkle to orange", async () => {
  const { waveBarColor, WAVE_QUIET_COLOR } = await loadMath();

  assert.equal(waveBarColor(0, 40), "rgb(143,170,255)");
  assert.equal(waveBarColor(39, 40), "rgb(255,162,62)");
  // A single bar must not divide by zero.
  assert.equal(waveBarColor(0, 1), "rgb(143,170,255)");
  // The quiet layer is the gradient's periwinkle end, uniform across the strip.
  assert.equal(WAVE_QUIET_COLOR, "rgb(143,170,255)");
});

test("per-sample visuals keep the old height/alpha curve as scaleY + layer opacity", async () => {
  const { waveBarVisual } = await loadMath();

  // Quiet floor: the old uniform 2px periwinkle bar at 0.35 alpha — the
  // gradient-hued active layer is fully faded out.
  assert.deepEqual(waveBarVisual(0), { scaleY: 2 / 20, quietOpacity: 0.35, activeOpacity: 0 });
  assert.deepEqual(waveBarVisual(0.13), { scaleY: 2 / 20, quietOpacity: 0.35, activeOpacity: 0 });

  // Loud: height = round(sqrt(norm) * 20), alpha = 0.55 + 0.45 * norm on the
  // gradient layer, quiet layer fully faded out.
  assert.deepEqual(waveBarVisual(0.5), {
    scaleY: Math.round(Math.sqrt(0.5) * 20) / 20,
    quietOpacity: 0,
    activeOpacity: 0.55 + 0.45 * 0.5,
  });
  assert.deepEqual(waveBarVisual(1), { scaleY: 1, quietOpacity: 0, activeOpacity: 1 });
});

test("bars render with static colors and compositor-only animated properties", async () => {
  const { LiveWaveform } = await loadComponent();

  const html = renderStatic(LiveWaveform, { readLevel: () => 0, bars: 5 });

  // Five bars at the rest scale, each with a fixed layout height.
  assert.equal(html.split("scaleY(0.1)").length - 1, 5);
  assert.equal(html.split("height:20px").length - 1, 5);

  // At rest every bar shows only the uniform quiet periwinkle at 0.35 alpha…
  assert.equal(html.split("background-color:rgb(143,170,255);opacity:0.35").length - 1, 5);
  // …while each bar's gradient-hued active layer is fully faded out.
  assert.equal(html.split('opacity:0"').length - 1, 5);
  assert.ok(html.includes('background-color:rgb(255,162,62);opacity:0"'));

  // The regression being fixed: bars must not transition height or
  // background-color (both retrigger layout/paint on every 150ms sample).
  assert.ok(html.includes("transition-transform"));
  assert.ok(html.includes("transition-opacity"));
  assert.ok(!html.includes("transition-[height"));
  assert.ok(!html.includes("background-color]"));
});
