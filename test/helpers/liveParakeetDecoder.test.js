const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/liveParakeetDecoder.js");
const loadTap = () => import("../../src/helpers/pcmTap.js");
const loadWav = () => import("../../src/utils/wavBuilder.ts");

const RATE = 16000;
const ROUTE = { model: "parakeet-unified-en-0.6b", language: "en" };

// Int16 PCM: a loud 220 Hz tone with gaps at the given [start, end) seconds.
// A gap is silent, or holds `level` (a peak amplitude) of noise-like tone.
function speech(seconds, gaps = [], level = 0) {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) {
    const t = i / RATE;
    const gap = gaps.some(([start, end]) => t >= start && t < end);
    const amplitude = gap ? level : 8000;
    samples[i] = Math.round(amplitude * Math.sin(2 * Math.PI * 220 * t));
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

const pcmLength = (wav) => (wav.byteLength - 44) / 2;
const settle = () => new Promise(setImmediate);

// Polls until no new cut appears, letting each stretch's decode resolve first.
async function pollAll(decoder) {
  for (let previous = -1; decoder.segmentCount !== previous;) {
    previous = decoder.segmentCount;
    decoder._poll();
    await settle();
  }
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

test("findLiveCut takes room tone 20 dB down as a pause", async () => {
  const { findLiveCut } = await load();
  const cut = findLiveCut(speech(10, [[8, 8.4]], 400));
  assert.ok(cut >= 8 * RATE && cut < 8.4 * RATE, `cut at ${cut / RATE}s`);
});

test("findLiveCut does not take a soft syllable 12 dB down for a pause", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(12, [[9, 9.25]], 2000)), null);
});

test("findLiveCut ignores a pause too short to end a sentence", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(10, [[8, 8.1]])), null);
});

test("findLiveCut ignores a pause still at the newest audio", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(speech(8.3, [[8, 8.3]])), null);
});

test("findLiveCut finds no pause in a muted mic", async () => {
  const { findLiveCut } = await load();
  assert.equal(findLiveCut(new Int16Array(10 * RATE)), null);
});

test("findLiveCut forces a cut at the quietest moment by fifteen seconds", async () => {
  const { findLiveCut } = await load();
  // The dip is too loud to be a pause but is still the quietest moment.
  const audio = speech(15.5, [[12.5, 12.8]], 3000);
  assert.equal(findLiveCut(audio.subarray(0, 15.2 * RATE)), null, "newest audio is guarded");
  const cut = findLiveCut(audio);
  assert.ok(cut >= 12.5 * RATE && cut < 12.8 * RATE, `cut at ${cut / RATE}s`);
});

test("a recording the batch path keeps whole is never cut", async () => {
  const { LiveParakeetDecoder } = await load();
  const samples = speech(15, [[8, 8.4]]);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () => {
      calls += 1;
      return { success: true, text: "x" };
    },
    ROUTE
  );
  decoder._poll();
  assert.equal(decoder.segmentCount, 0);
  assert.equal(calls, 0);
});

test("stretches join in recording order with the tail, each decoded once", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(40, [
    [10, 10.4],
    [20, 20.4],
    [30, 30.4],
  ]);
  const lengths = [];
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async (wav) => {
      const index = lengths.push(pcmLength(wav));
      // Later stretches answer first: the join must still follow the audio.
      await new Promise((resolve) => setTimeout(resolve, 20 - index * 5));
      return { success: true, text: `Part ${index}.` };
    },
    ROUTE
  );
  for (let previous = -1; decoder.segmentCount !== previous;) {
    previous = decoder.segmentCount;
    decoder._poll();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(decoder.segmentCount, 3);

  const text = await decoder.finish(buildWav(samples, RATE), ROUTE);
  assert.equal(text, "Part 1. Part 2. Part 3. Part 4.");
  assert.equal(
    lengths.reduce((sum, length) => sum + length, 0),
    samples.length
  );
});

test("only one stretch is decoded at a time", async () => {
  const { LiveParakeetDecoder } = await load();
  const samples = speech(40, [
    [10, 10.4],
    [20, 20.4],
  ]);
  let release;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    () =>
      new Promise((resolve) => {
        release = () => resolve({ success: true, text: "x" });
      }),
    ROUTE
  );
  decoder._poll();
  await settle();
  decoder._poll();
  assert.equal(decoder.segmentCount, 1);
  release();
  await settle();
  decoder._poll();
  assert.equal(decoder.segmentCount, 2);
});

test("a silent stretch adds nothing to the text", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[0, 8]]);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () =>
      ++calls === 1
        ? { success: false, code: "NO_SPEECH_DETECTED" }
        : { success: true, text: "Tail." },
    ROUTE
  );
  await pollAll(decoder);
  assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), "Tail.");
});

test("an audible stretch that decodes empty hands the recording to the batch path", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () =>
      ++calls === 1
        ? { success: false, code: "NO_SPEECH_DETECTED" }
        : { success: true, text: "Tail." },
    ROUTE
  );
  await pollAll(decoder);
  assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), null);
});

test("a partial stretch hands the recording to the batch path, which reports it", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () => ({ success: true, text: "Some.", warning: "truncated" }),
    ROUTE
  );
  await pollAll(decoder);
  assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), null);
});

test("a failed or rejected stretch hands the recording to the batch path", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  for (const transcribe of [
    async () => ({ success: false, error: "invalid_response" }),
    async () => {
      throw new Error("ipc down");
    },
  ]) {
    const decoder = new LiveParakeetDecoder(fakeTap(samples), transcribe, ROUTE);
    await pollAll(decoder);
    assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), null);
  }
});

test("a recording with no speech anywhere hands back null", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = new Int16Array(20 * RATE);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () => {
      calls += 1;
      return { success: false, code: "NO_SPEECH_DETECTED" };
    },
    ROUTE
  );
  await pollAll(decoder);
  assert.equal(decoder.segmentCount, 1);
  assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), null);
  assert.equal(calls, 1, "the silent tail is not decoded");
});

test("a tail of room tone after the last cut is not decoded", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(
    22,
    [
      [10, 10.4],
      [20.5, 22],
    ],
    400
  );
  const lengths = [];
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async (wav) => {
      lengths.push(pcmLength(wav));
      return { success: true, text: `Part ${lengths.length}.` };
    },
    ROUTE
  );
  await pollAll(decoder);
  assert.equal(decoder.segmentCount, 2);
  assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), "Part 1. Part 2.");
  assert.equal(lengths.length, 2);
});

test("a short spoken tail is decoded together with the stretch before it", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(22, [
    [10, 10.4],
    [20.5, 21.5],
  ]);
  const lengths = [];
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async (wav) => {
      lengths.push(pcmLength(wav));
      return { success: true, text: `Part ${lengths.length}.` };
    },
    ROUTE
  );
  await pollAll(decoder);
  assert.equal(decoder.segmentCount, 2);
  const text = await decoder.finish(buildWav(samples, RATE), ROUTE);
  assert.equal(text, "Part 1. Part 3.");
  assert.equal(lengths[0] + lengths[2], samples.length, "the redo covers the rest of the audio");
});

test("a tail under a tenth of a second is skipped", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () => {
      calls += 1;
      return { success: true, text: "Part." };
    },
    ROUTE
  );
  await pollAll(decoder);
  const cut = 10.1 * RATE;
  const text = await decoder.finish(buildWav(samples.subarray(0, cut + 0.05 * RATE), RATE), ROUTE);
  assert.equal(text, "Part.");
  assert.equal(calls, 1);
});

test("finish decodes the tail once however often it is called", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  let calls = 0;
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () => {
      calls += 1;
      return { success: true, text: "x" };
    },
    ROUTE
  );
  await pollAll(decoder);
  const wav = buildWav(samples, RATE);
  assert.equal(await decoder.finish(wav, ROUTE), await decoder.finish(wav, ROUTE));
  assert.equal(calls, 2);
});

test("finish discards the live text when the model or language changed", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  const decoder = new LiveParakeetDecoder(
    fakeTap(samples),
    async () => ({ success: true, text: "x" }),
    ROUTE
  );
  await pollAll(decoder);
  const wav = buildWav(samples, RATE);
  assert.equal(await decoder.finish(wav, { ...ROUTE, model: "parakeet-tdt-0.6b-v3" }), null);
  assert.equal(await decoder.finish(wav, { ...ROUTE, language: "de" }), null);
});

test("finish defers to the batch path when nothing was decoded live or the capture is missing", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const short = speech(4);
  const ok = async () => ({ success: true, text: "x" });
  const idle = new LiveParakeetDecoder(fakeTap(short), ok, ROUTE);
  idle._poll();
  assert.equal(await idle.finish(buildWav(short, RATE), ROUTE), null);

  const samples = speech(20, [[10, 10.4]]);
  const noWav = new LiveParakeetDecoder(fakeTap(samples), ok, ROUTE);
  await pollAll(noWav);
  assert.equal(await noWav.finish(null, ROUTE), null);

  const truncated = new LiveParakeetDecoder(fakeTap(samples), ok, ROUTE);
  await pollAll(truncated);
  const shorter = buildWav(samples.subarray(0, 5 * RATE), RATE);
  assert.equal(await truncated.finish(shorter, ROUTE), null);
});

test("new audio from the tap drives the cut checks until stop detaches it", async () => {
  const { LiveParakeetDecoder } = await load();
  const samples = speech(20, [[10, 10.4]]);
  const tap = fakeTap(samples);
  let decodes = 0;
  const decoder = new LiveParakeetDecoder(
    tap,
    async () => {
      decodes += 1;
      return { success: true, text: "x" };
    },
    ROUTE
  );
  tap.onSamples(RATE / 4);
  assert.equal(decoder.segmentCount, 0, "a quarter second is too little to look again");
  tap.onSamples(samples.length);
  assert.equal(decoder.segmentCount, 1);
  decoder.stop();
  assert.equal(tap.onSamples, null);
  await settle();
  assert.equal(decodes, 1);
});

test("PcmTap reports each chunk's running count and reads 0 once dropped", async () => {
  const { PcmTap } = await loadTap();
  const counts = [];
  const tap = Object.assign(Object.create(PcmTap.prototype), {
    _chunks: [],
    _samples: 0,
    _maxSamples: 5,
    _dropped: false,
    onSamples: (count) => counts.push(count),
  });
  tap._onMessage(Int16Array.of(1, 2, 3).buffer);
  assert.deepEqual(counts, [3]);
  assert.equal(tap.sampleCount, 3);
  tap._onMessage(Int16Array.of(4, 5, 6).buffer);
  assert.deepEqual(counts, [3], "the overflowing chunk drops the copy");
  assert.equal(tap.sampleCount, 0);
});

test("a dropped tap stops the cuts and hands the recording to the batch path", async () => {
  const { LiveParakeetDecoder } = await load();
  const { buildWav } = await loadWav();
  const samples = speech(20, [[10, 10.4]]);
  const tap = { sampleCount: 0, copySamples: () => new Int16Array(0) };
  const decoder = new LiveParakeetDecoder(tap, async () => ({ success: true, text: "x" }), ROUTE);
  decoder._poll();
  assert.equal(decoder.segmentCount, 0);
  assert.equal(await decoder.finish(buildWav(samples, RATE), ROUTE), null);
});

test("PcmTap.copySamples reads across worklet chunk boundaries", async () => {
  const { PcmTap } = await loadTap();
  const tap = { _chunks: [Int16Array.of(1, 2, 3), Int16Array.of(4, 5), Int16Array.of(6, 7, 8)] };
  const copy = (start, end) => Array.from(PcmTap.prototype.copySamples.call(tap, start, end));
  assert.deepEqual(copy(0, 8), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(copy(2, 6), [3, 4, 5, 6]);
  assert.deepEqual(copy(5, 5), []);
});
