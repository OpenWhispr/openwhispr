const test = require("node:test");
const assert = require("node:assert");
const {
  computeFbank,
  FBANK_NUM_MELS,
  FBANK_FRAME_LENGTH,
  FBANK_FRAME_SHIFT,
} = require("../../src/workers/speakerFbank");

const SR = 16000;

// Deterministic broadband noise (seeded LCG). Broadband so every mel band carries
// real energy well above the log floor — that keeps the loudness/DC invariance
// properties exact rather than tripping the energy-floor clamp on empty bands.
function makeSignal(seconds, amplitude = 0.3) {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  let state = 0x9e3779b9 >>> 0;
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = ((state / 0xffffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test("frame count follows the Kaldi snip-edges formula", () => {
  const samples = makeSignal(2);
  const { numFrames, features } = computeFbank(samples);
  const expected = Math.floor((samples.length - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT) + 1;
  assert.strictEqual(numFrames, expected);
  assert.strictEqual(features.length, numFrames * FBANK_NUM_MELS);
});

test("returns null when there is not even one full frame", () => {
  assert.strictEqual(computeFbank(new Float32Array(FBANK_FRAME_LENGTH - 1)), null);
});

test("CMN makes every mel band zero-mean over time", () => {
  const { features, numFrames } = computeFbank(makeSignal(2));
  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    let mean = 0;
    for (let f = 0; f < numFrames; f++) mean += features[f * FBANK_NUM_MELS + m];
    mean /= numFrames;
    assert.ok(Math.abs(mean) < 1e-4, `mel band ${m} mean ${mean} not ~0`);
  }
});

test("features are invariant to overall loudness (log-gain + CMN cancel)", () => {
  const base = makeSignal(2);
  const scaled = base.map((x) => x * 0.35);
  const a = computeFbank(base).features;
  const b = computeFbank(scaled).features;
  // Without CMN a 0.35x gain shifts every bin by log(0.35^2); CMN removes it.
  assert.ok(maxAbsDiff(a, b) < 1e-3, `gain changed features by ${maxAbsDiff(a, b)}`);
});

test("features are invariant to a constant DC offset (per-frame DC removal)", () => {
  const base = makeSignal(2);
  const shifted = base.map((x) => x + 0.1);
  const a = computeFbank(base).features;
  const b = computeFbank(shifted).features;
  assert.ok(maxAbsDiff(a, b) < 1e-3, `DC offset changed features by ${maxAbsDiff(a, b)}`);
});

test("produces finite features (no NaN/Inf) including on silence", () => {
  for (const sig of [makeSignal(2), new Float32Array(SR * 2)]) {
    const { features } = computeFbank(sig);
    for (let i = 0; i < features.length; i++) {
      assert.ok(Number.isFinite(features[i]), `feature ${i} not finite`);
    }
  }
});
