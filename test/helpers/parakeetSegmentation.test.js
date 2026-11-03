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
  assert.deepEqual(segments.map(seconds), [13.15, 3.85]);
});

test("a long silence is cut in its middle, away from the words on either side", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 11.5 }, { seconds: 3.4, amplitude: 0 }, { seconds: 1.1 }]),
    OPTIONS
  );
  assert.equal(seconds(segments[0]), 13.2);
});

test("a pause just inside the search window moves the cut", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 11.3 }, { seconds: 0.5, amplitude: 0 }, { seconds: 4.2 }]),
    OPTIONS
  );
  assert.equal(seconds(segments[0]), 11.55);
});

test("a pause just before the search window leaves the cut at the limit", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 10.5 }, { seconds: 0.45, amplitude: 0 }, { seconds: 5.05 }]),
    OPTIONS
  );
  assert.equal(seconds(segments[0]), 15);
});

test("a stretch under half the energy at the limit moves the cut, one above it does not", () => {
  // Energy scales with amplitude squared: 0.3 is 0.36 of the 0.5 tone, 0.4 is 0.64.
  const withStretch = (amplitude) =>
    seconds(
      splitAtPauses(
        pcm([{ seconds: 12 }, { seconds: 0.5, amplitude }, { seconds: 3.5 }]),
        OPTIONS
      )[0]
    );
  const quieter = withStretch(0.3);
  assert.ok(quieter > 12 && quieter < 12.5, `cut at ${quieter}s, expected inside the stretch`);
  assert.equal(withStretch(0.4), 15);
});

test("the stretch is compared with the audio at the limit, not the start of the search", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 11 }, { seconds: 0.5, amplitude: 0.05 }, { seconds: 4.5 }]),
    OPTIONS
  );
  const cut = seconds(segments[0]);
  assert.ok(cut > 11 && cut < 11.5, `cut at ${cut}s, expected inside the soft stretch`);
});

test("a cut moves earlier only when that does not add a segment", () => {
  // Cutting at 12 s would leave 16 s, so a third, 1 s segment.
  const twoSegments = splitAtPauses(
    pcm([{ seconds: 12 }, { seconds: 0.3, amplitude: 0 }, { seconds: 15.7 }]),
    OPTIONS
  );
  assert.deepEqual(twoSegments.map(seconds), [15, 13]);

  const threeSegments = splitAtPauses(
    pcm([{ seconds: 13 }, { seconds: 0.3, amplitude: 0 }, { seconds: 26.7 }]),
    OPTIONS
  );
  assert.deepEqual(threeSegments.map(seconds), [13.15, 15, 11.85]);
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

test("a soft stretch of 110 ms is long enough to count as a pause", () => {
  const segments = splitAtPauses(
    pcm([{ seconds: 13 }, { seconds: 0.11, amplitude: 0.25 }, { seconds: 3.89 }]),
    OPTIONS
  );
  const cut = seconds(segments[0]);
  assert.ok(cut > 13 && cut < 13.11, `cut at ${cut}s, expected inside the stretch`);
});

test("a cut with no room left to move stays at the limit", () => {
  // Any earlier cut would push the 15.47 s remainder past the last segment's allowance.
  const segments = splitAtPauses(
    pcm([{ seconds: 14.97 }, { seconds: 0.03, amplitude: 0 }, { seconds: 15.47 }]),
    OPTIONS
  );
  assert.deepEqual(segments.map(seconds), [15, 15.47]);
});

test("the last segment's allowance neither adds a segment nor stops a cut moving into a pause", () => {
  const noExtraSegment = splitAtPauses(
    pcm([{ seconds: 12 }, { seconds: 0.3, amplitude: 0 }, { seconds: 17.95 }]),
    OPTIONS
  );
  assert.deepEqual(noExtraSegment.map(seconds), [15, 15.25]);

  const intoPause = splitAtPauses(
    pcm([{ seconds: 14.6 }, { seconds: 0.3, amplitude: 0 }, { seconds: 15.4 }]),
    OPTIONS
  );
  assert.deepEqual(intoPause.map(seconds), [14.85, 15.45]);
});

test("a remainder under half a second joins the last segment instead of decoding alone", () => {
  assert.deepEqual(splitAtPauses(pcm([{ seconds: 15.25 }]), OPTIONS).map(seconds), [15.25]);
  assert.deepEqual(splitAtPauses(pcm([{ seconds: 30.25 }]), OPTIONS).map(seconds), [15, 15.25]);
  assert.deepEqual(splitAtPauses(pcm([{ seconds: 15.75 }]), OPTIONS).map(seconds), [15, 0.75]);
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
