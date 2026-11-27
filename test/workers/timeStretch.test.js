const test = require("node:test");
const assert = require("node:assert/strict");
const { timeStretch } = require("../../src/workers/timeStretch");

const RATE = 16000;
const tone = (seconds, hz) =>
  Float32Array.from(
    { length: seconds * RATE },
    (_, index) => 0.5 * Math.sin((2 * Math.PI * hz * index) / RATE)
  );
// Upward zero crossings per second: the tone's pitch.
const pitch = (samples) => {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1] < 0 && samples[index] >= 0) crossings += 1;
  }
  return (crossings * RATE) / samples.length;
};

test("a faster rate shortens speech in proportion and keeps its pitch", () => {
  const source = tone(2, 200);
  for (const rate of [1.5, 2]) {
    const stretched = timeStretch(source, rate, RATE);
    const expected = source.length / rate;
    assert.ok(Math.abs(stretched.length - expected) < RATE * 0.05, `${rate}x length`);
    assert.ok(Math.abs(pitch(stretched) - 200) < 5, `${rate}x pitch ${pitch(stretched)}`);
  }
});

test("at 1x the clip is left as it is", () => {
  const source = tone(1, 200);
  assert.equal(timeStretch(source, 1, RATE), source);
});
