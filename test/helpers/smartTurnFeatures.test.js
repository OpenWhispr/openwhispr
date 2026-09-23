const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SMART_TURN_SAMPLES,
  SMART_TURN_MELS,
  SMART_TURN_FRAMES,
  prepareSmartTurnAudio,
  whisperLogMel,
} = require("../../src/helpers/smartTurnFeatures");
const fixture = require("./fixtures/smartTurnLogMel.fixture.json");

// Same deterministic signal the fixture generator used (tone + LCG noise).
function fixtureSignal(sampleCount) {
  const out = new Float32Array(sampleCount);
  let state = 12345;
  for (let n = 0; n < sampleCount; n += 1) {
    state = Number((1664525n * BigInt(state) + 1013904223n) % 4294967296n);
    const tone =
      0.3 *
      Math.sin((2 * Math.PI * 220 * n) / 16000) *
      (0.5 + 0.5 * Math.sin((2 * Math.PI * 1.5 * n) / 16000));
    out[n] = tone + 0.05 * (state / 4294967296 - 0.5);
  }
  return out;
}

test("pads short audio with zeros at the start so the speech sits at the end", () => {
  const prepared = prepareSmartTurnAudio(new Float32Array([0.5, -0.25]));
  assert.equal(prepared.length, SMART_TURN_SAMPLES);
  assert.equal(prepared[0], 0);
  assert.equal(prepared[SMART_TURN_SAMPLES - 3], 0);
  assert.equal(prepared[SMART_TURN_SAMPLES - 2], 0.5);
  assert.equal(prepared[SMART_TURN_SAMPLES - 1], -0.25);
});

test("keeps only the last 8 seconds of long audio", () => {
  const long = new Float32Array(SMART_TURN_SAMPLES + 10);
  long[9] = 1;
  long[10] = 2;
  long[long.length - 1] = 3;
  const prepared = prepareSmartTurnAudio(long);
  assert.equal(prepared.length, SMART_TURN_SAMPLES);
  assert.equal(prepared[0], 2);
  assert.equal(prepared[SMART_TURN_SAMPLES - 1], 3);
});

test("log-mel features match pipecat's numpy reference", () => {
  const features = whisperLogMel(prepareSmartTurnAudio(fixtureSignal(48000)));
  assert.deepEqual([SMART_TURN_MELS, SMART_TURN_FRAMES], fixture.shape);
  assert.equal(features.length, SMART_TURN_MELS * SMART_TURN_FRAMES);

  let worst = 0;
  fixture.values.forEach((expected, index) => {
    worst = Math.max(worst, Math.abs(features[index * fixture.stride] - expected));
  });
  assert.ok(worst < 1e-5, `max abs error ${worst}`);

  const mean = features.reduce((sum, value) => sum + value, 0) / features.length;
  assert.ok(Math.abs(mean - fixture.mean) < 1e-4, `mean ${mean} vs ${fixture.mean}`);
});

test("silence maps to the floor value instead of NaN", () => {
  const features = whisperLogMel(new Float32Array(SMART_TURN_SAMPLES));
  assert.ok(features.every((value) => Math.abs(value - -1.5) < 1e-6));
});
