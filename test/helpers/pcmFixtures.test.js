const test = require("node:test");
const assert = require("node:assert/strict");

const fx = require("./harness/pcmFixtures");

test("makeSine has the expected length and RMS ≈ amplitude/√2", () => {
  const sine = fx.makeSine({ frequencyHz: 440, durationMs: 100, amplitude: 0.5 });
  assert.equal(sine.length, 2400);
  const expected = 0.5 / Math.SQRT2;
  assert.ok(Math.abs(fx.rmsOf(sine) - expected) < expected * 0.02, `rms ${fx.rmsOf(sine)}`);
});

test("makeSeededNoise is deterministic per seed and bounded by amplitude", () => {
  const a = fx.makeSeededNoise({ durationMs: 50, amplitude: 0.2, seed: 7 });
  const b = fx.makeSeededNoise({ durationMs: 50, amplitude: 0.2, seed: 7 });
  const c = fx.makeSeededNoise({ durationMs: 50, amplitude: 0.2, seed: 8 });
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
  assert.ok(a.every((v) => v >= -0.2 && v <= 0.2));
  assert.equal(a.length, 1200);
});

test("delayBy prepends silence and preserves the payload", () => {
  const src = fx.makeSine({ frequencyHz: 100, durationMs: 10, amplitude: 0.5 });
  const delayed = fx.delayBy(src, 5);
  assert.equal(delayed.length, src.length + 120);
  assert.ok(delayed.subarray(0, 120).every((v) => v === 0));
  assert.deepEqual(Array.from(delayed.subarray(120)), Array.from(src));
});

test("mix sums and clamps; scale multiplies", () => {
  // Values chosen to be exactly representable in float32 so deepEqual is safe.
  const one = new Float32Array([0.5, -0.5, 0.75]);
  const two = new Float32Array([0.5, -0.9]);
  assert.deepEqual(Array.from(fx.mix(one, two)), [1, -1, 0.75]);
  assert.deepEqual(Array.from(fx.scale(one, 0.5)), [0.25, -0.25, 0.375]);
  assert.ok(Math.abs(fx.dbToGain(-12) - 0.2512) < 0.001);
});

test("toInt16Buffer round-trips within 1 LSB and chunkBuffer splits by sample count", () => {
  const track = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const buf = fx.toInt16Buffer(track);
  assert.equal(buf.length, 14);
  const view = new Int16Array(buf.buffer, buf.byteOffset, 7);
  assert.deepEqual(Array.from(view), [0, 16384, -16384, 32767, -32768, 32767, -32768]);
  const chunks = fx.chunkBuffer(buf, 3);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [6, 6, 2]
  );
});
