const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/liveParakeetDecoder.js");
const loadTap = () => import("../../src/helpers/pcmTap.js");
const loadWav = () => import("../../src/utils/wavBuilder.ts");

const RATE = 16000;

// Int16 PCM: a loud 220 Hz tone with silent gaps at the given [start, end) seconds.
function speech(seconds, gaps = []) {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    const silent = gaps.some(([start, end]) => t >= start && t < end);
    samples[i] = silent ? 0 : Math.round(8000 * Math.sin(2 * Math.PI * 220 * t));
  }
  return samples;
}

// A PcmTap stand-in that has captured `samples` so far.
function fakeTap(samples) {
  return {
    sampleCount: samples.length,
    copySamples: (start, end) => samples.slice(start, end),
  };
}

test("findLiveCut waits for six seconds of audio", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(5.5, [[3, 3.5]])), null);
});

test("findLiveCut cuts inside a clear pause", async () => {
  const { findLiveCut } = await load();
  const cut = findLiveCut(speech(10, [[8, 8.4]]));
  assert.ok(cut >= 8 * RATE && cut < 8.4 * RATE, `cut at ${cut / RATE}s`);
});

test("findLiveCut ignores a pause too short to end a sentence", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(10, [[8, 8.1]])), null);
});

test("findLiveCut ignores a pause still at the newest audio", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(8.3, [[8, 8.3]])), null);
});

test("findLiveCut forces a cut by fifteen seconds without a pause", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(14)), null);
  const cut = findLiveCut(speech(15.5));
  assert.ok(cut >= 11 * RATE && cut <= 15 * RATE, `cut at ${cut / RATE}s`);
});

test("the decoder joins live stretches with the tail and decodes each once", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(12, [[7, 7.4]]);
  const lengths = [];
  const texts = ["First part.", "Second part."];
  const decoder = new LiveParakeetDecoder(fakeTap(samples), async (wav) => {
    lengths.push((wav.byteLength - 44) / 2);
    return { success: true, text: texts[lengths.length - 1] };
  });
  decoder._poll();
  decoder._poll();
  assert.equal(decoder.segmentCount, 1);

  const text = await decoder.finish(buildWav(samples, RATE));
  assert.equal(text, "First part. Second part.");
  assert.equal(lengths.length, 2);
  assert.equal(lengths[0] + lengths[1], samples.length);
});

test("a stretch with no speech adds nothing to the text", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(12, [[7, 7.4]]);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(fakeTap(samples), async () =>
    ++calls === 1
      ? { success: false, code: "NO_SPEECH_DETECTED" }
      : { success: true, text: "Tail." }
  );
  decoder._poll();
  assert.equal(await decoder.finish(buildWav(samples, RATE)), "Tail.");
});

test("a failed stretch hands the whole recording back to the batch path", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(12, [[7, 7.4]]);
  const decoder = new LiveParakeetDecoder(fakeTap(samples), async () => ({
    success: false,
    error: "invalid_response",
  }));
  decoder._poll();
  assert.equal(await decoder.finish(buildWav(samples, RATE)), null);
});

test("finish defers to the batch path when nothing was decoded live or the capture is missing", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const short = speech(4);
  const idle = new LiveParakeetDecoder(fakeTap(short), async () => ({ success: true, text: "x" }));
  idle._poll();
  assert.equal(await idle.finish(buildWav(short, RATE)), null);

  const samples = speech(12, [[7, 7.4]]);
  const noWav = new LiveParakeetDecoder(fakeTap(samples), async () => ({
    success: true,
    text: "x",
  }));
  noWav._poll();
  assert.equal(await noWav.finish(null), null);
});

test("new audio from the tap drives the cut checks until stop detaches it", async () => {
  const { LiveParakeetDecoder } = await load();
  const samples = speech(12, [[7, 7.4]]);
  const tap = fakeTap(samples);
  let decodes = 0;
  const decoder = new LiveParakeetDecoder(tap, async () => {
    decodes += 1;
    return { success: true, text: "x" };
  });
  tap.onSamples(RATE / 4);
  assert.equal(decoder.segmentCount, 0, "a quarter second is too little to look again");
  tap.onSamples(samples.length);
  assert.equal(decoder.segmentCount, 1);
  decoder.stop();
  assert.equal(tap.onSamples, null);
  await new Promise(setImmediate);
  assert.equal(decodes, 1);
});

test("PcmTap.copySamples reads across worklet chunk boundaries", async () => {
  const { PcmTap } = await loadTap();
  const tap = { _chunks: [Int16Array.of(1, 2, 3), Int16Array.of(4, 5), Int16Array.of(6, 7, 8)] };
  const copy = (start, end) => Array.from(PcmTap.prototype.copySamples.call(tap, start, end));
  assert.deepEqual(copy(0, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(copy(2, 6), [3, 4, 5, 6]);
  assert.deepEqual(copy(5, 5), []);
});
