const test = require("node:test");
const assert = require("node:assert/strict");

const { splitAtPauses } = require("../../src/helpers/parakeetSegmentation");

const SAMPLE_RATE = 16000;
const OPTIONS = { sampleRate: SAMPLE_RATE, maxSegmentSeconds: 15 };

// Float32 PCM from spans of a 200 Hz tone; `amplitude: 0` is a pause.
function pcm(spans) {
  const total = spans.reduce((sum, span) => sum + Math.round(span.seconds * SAMPLE_RATE), 0);
  const buf = Buffer.alloc(total * 4);
  let index = 0;
  for (const { seconds, amplitude = 0.5 } of spans) {
    for (let i = 0; i < Math.round(seconds * SAMPLE_RATE); i++, index++) {
      buf.writeFloatLE(amplitude * Math.sin((2 * Math.PI * 200 * index) / SAMPLE_RATE), index * 4);
    }
  }
  return buf;
}

const seconds = (segment) => segment.length / 4 / SAMPLE_RATE;

test("audio within the limit stays one segment", () => {
  const samples = pcm([{ seconds: 15 }]);
  const segments = splitAtPauses(samples, OPTIONS);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].length, samples.length);
});

test("without a pause the cut stays at the limit", () => {
  const segments = splitAtPauses(pcm([{ seconds: 31 }]), OPTIONS);
  assert.deepEqual(segments.map(seconds), [15, 15, 1]);
});

test("the cut moves into a pause shortly before the limit", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 13 }, { seconds: 0.3, amplitude: 0 }, { seconds: 3.7 }]),
    OPTIONS
  );
  assert.equal(segments.length, 2);
  const cut = seconds(segments[0]);
  assert.ok(cut > 13 && cut < 13.3, `cut at ${cut}s, expected inside the 13.0-13.3s pause`);
});

test("a softer stretch counts as a pause, not only digital silence", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 12 }, { seconds: 0.2, amplitude: 0.02 }, { seconds: 5 }]),
    OPTIONS
  );
  const cut = seconds(segments[0]);
  assert.ok(cut > 12 && cut < 12.2, `cut at ${cut}s, expected inside the soft stretch`);
});

test("a pause too early for the search window leaves the cut at the limit", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 5 }, { seconds: 0.5, amplitude: 0 }, { seconds: 11.5 }]),
    OPTIONS
  );
  assert.deepEqual(segments.map(seconds), [15, 2]);
});

test("a dip shorter than a pause window does not move the cut", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 13 }, { seconds: 0.03, amplitude: 0 }, { seconds: 4 }]),
    OPTIONS
  );
  assert.equal(seconds(segments[0]), 15);
});

test("segments cover the input in order without gaps or overlap", () => {
  const samples = pcm([
    { seconds: 14 },
    { seconds: 0.4, amplitude: 0 },
    { seconds: 13.6 },
    { seconds: 0.4, amplitude: 0 },
    { seconds: 6 },
  ]);
  const segments = splitAtPauses(samples, OPTIONS);
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => seconds(segment) <= 15));
  assert.ok(segments.every((segment) => segment.length % 4 === 0));
  assert.ok(Buffer.concat(segments).equals(samples));
});
