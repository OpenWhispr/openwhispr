const test = require("node:test");
const assert = require("node:assert/strict");

const { createSampleBuffer, createVoiceActivityDetector } = require("../../src/workers/sileroVad");

const WINDOW = 512;
const CONFIG = {
  threshold: 0.5,
  minSilenceDuration: 0.2,
  minSpeechDuration: 0.15,
  maxSpeechDuration: 20,
  windowSize: WINDOW,
};

/** A detector that reads one scripted probability per window. */
function scripted(probabilities, config = CONFIG) {
  let index = 0;
  return createVoiceActivityDetector({
    config,
    readProbability: async () => probabilities[index++] ?? 0,
  });
}

async function feed(detector, windows) {
  for (let index = 0; index < windows; index += 1) {
    await detector.acceptWaveform(new Float32Array(WINDOW));
  }
}

const repeat = (value, count) => new Array(count).fill(value);

test("a burst shorter than the minimum speech time is not speech", async () => {
  const detector = scripted([...repeat(0, 10), ...repeat(0.9, 3), ...repeat(0, 20)]);
  await feed(detector, 33);
  assert.equal(detector.isDetected(), false);
  assert.equal(detector.isEmpty(), true);
});

test("speech is detected, then ends as one segment after the minimum silence", async () => {
  const detector = scripted([...repeat(0, 20), ...repeat(0.9, 30), ...repeat(0, 20)]);
  await feed(detector, 40);
  assert.equal(detector.isDetected(), true);
  await feed(detector, 30);
  assert.equal(detector.isDetected(), false);

  const segment = detector.front();
  // It reaches back over the time speech needed to be confirmed.
  assert.ok(segment.start < 20 * WINDOW);
  assert.equal(segment.samples.length > 30 * WINDOW * 0.5, true);
  detector.pop();
  assert.equal(detector.isEmpty(), true);
});

test("a pause shorter than the minimum silence keeps one segment", async () => {
  const detector = scripted([
    ...repeat(0.9, 20),
    ...repeat(0, 3),
    ...repeat(0.9, 20),
    ...repeat(0, 20),
  ]);
  await feed(detector, 63);
  assert.equal(detector.isEmpty(), false);
  detector.pop();
  assert.equal(detector.isEmpty(), true);
});

test("frames of any size are read in whole windows", async () => {
  let reads = 0;
  const detector = createVoiceActivityDetector({
    config: CONFIG,
    readProbability: async () => {
      reads += 1;
      return 0;
    },
  });
  await detector.acceptWaveform(new Float32Array(300));
  assert.equal(reads, 0);
  await detector.acceptWaveform(new Float32Array(300));
  assert.equal(reads, 1);
  await detector.acceptWaveform(new Float32Array(WINDOW * 2));
  assert.equal(reads, 3);
});

test("a reset during a read drops that read and everything before it", async () => {
  let release;
  const detector = createVoiceActivityDetector({
    config: CONFIG,
    readProbability: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const reading = detector.acceptWaveform(new Float32Array(WINDOW));
  detector.reset();
  release(0.9);
  await reading;
  assert.equal(detector.isDetected(), false);
  assert.equal(detector.isEmpty(), true);
});

test("the sample buffer keeps stream positions across wrap-around and growth", () => {
  const buffer = createSampleBuffer(8);
  buffer.push(Float32Array.from([1, 2, 3, 4, 5, 6]));
  buffer.pop(4);
  buffer.push(Float32Array.from([7, 8, 9, 10]));
  assert.deepEqual([...buffer.get(4, 6)], [5, 6, 7, 8, 9, 10]);

  buffer.push(Float32Array.from([11, 12, 13, 14, 15]));
  assert.equal(buffer.head, 4);
  assert.equal(buffer.tail, 15);
  assert.deepEqual([...buffer.get(4, 11)], [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});
