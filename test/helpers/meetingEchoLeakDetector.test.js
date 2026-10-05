const test = require("node:test");
const assert = require("node:assert/strict");

const MeetingEchoLeakDetector = require("../../src/helpers/meetingEchoLeakDetector");

test("shouldSuppressMicSegment keeps bleed evidence even when share stays below render-bleed gate", () => {
  const detector = new MeetingEchoLeakDetector();
  const nowMs = 10_000;

  detector.systemHistory = [
    {
      timestampMs: nowMs - 250,
      durationMs: 120,
      rms: 0.02,
      samples: new Float32Array(2400),
    },
  ];

  detector.micHistory = [
    {
      timestampMs: nowMs - 420,
      durationMs: 120,
      rms: 0.02,
      correlation: 0.77,
      residualRatio: 0.4,
      explainedRatio: 0.6,
      systemRms: 0.02,
      micToSystemRatio: 1.1,
      state: "double_talk",
    },
    {
      timestampMs: nowMs - 300,
      durationMs: 120,
      rms: 0.02,
      correlation: 0.15,
      residualRatio: 0.9,
      explainedRatio: 0.1,
      systemRms: 0.02,
      micToSystemRatio: 1.1,
      state: "clean_local",
    },
    {
      timestampMs: nowMs - 180,
      durationMs: 120,
      rms: 0.02,
      correlation: 0.1,
      residualRatio: 0.95,
      explainedRatio: 0.05,
      systemRms: 0.02,
      micToSystemRatio: 1.1,
      state: "clean_local",
    },
    {
      timestampMs: nowMs - 60,
      durationMs: 120,
      rms: 0.02,
      correlation: 0.2,
      residualRatio: 0.85,
      explainedRatio: 0.15,
      systemRms: 0.02,
      micToSystemRatio: 1.1,
      state: "clean_local",
    },
  ];

  const result = detector.shouldSuppressMicSegment(nowMs - 500, nowMs);

  assert.equal(result.suppress, false);
  assert.equal(result.reason, "double_talk");
  assert.equal(result.hasBleedEvidence, true);
  assert.equal(result.likelyRenderBleed, false);
  assert.equal(result.bleedMatchCount, 1);
  assert.equal(result.sampleCount, 4);
});

const fx = require("./harness/pcmFixtures");

const CHUNK = 800; // renderer mic chunk = 800 samples @ 24 kHz ≈ 33 ms
const REF_MS = 1200; // ≥ 800 + 12000 samples so the lag search has a full window

// Feeds `reference` to the detector as system chunks and returns the sample index of the window end.
function feedReference(detector, reference, startMs = 0) {
  const chunks = fx.chunkBuffer(fx.toInt16Buffer(reference), CHUNK);
  chunks.forEach((chunk, i) =>
    detector.recordSystemChunk(chunk, startMs + Math.round((i * CHUNK * 1000) / 24000))
  );
  return reference.length;
}

// Mic chunk that "hears" the reference `delayMs` late: the reference slice that
// ends `delayMs` before the window end.
function delayedReferenceSlice(reference, delayMs, gain) {
  const delaySamples = Math.round((delayMs / 1000) * 24000);
  const end = reference.length - delaySamples;
  return fx.scale(reference.subarray(end - CHUNK, end), gain);
}

test("PCM: a −12 dB copy of the reference delayed 100 ms reads as render bleed and mutes", () => {
  const detector = new MeetingEchoLeakDetector();
  const reference = fx.makeSeededNoise({ durationMs: REF_MS, amplitude: 0.2, seed: 11 });
  feedReference(detector, reference);
  const mic = delayedReferenceSlice(reference, 100, fx.dbToGain(-12));

  const analysis = detector.analyzeMicChunk(fx.toInt16Buffer(mic), REF_MS);

  assert.ok(analysis.rms >= 0.006, `mic rms ${analysis.rms} must clear MIN_RMS`);
  assert.equal(analysis.state, "suspected_render_bleed");
  assert.ok(analysis.correlation > 0.95, `corr ${analysis.correlation}`);
  assert.ok(analysis.residualRatio < 0.1, `residual ${analysis.residualRatio}`);
  assert.ok(
    analysis.micToSystemRatio > 0.2 && analysis.micToSystemRatio < 0.3,
    `ratio ${analysis.micToSystemRatio}`
  );
  assert.equal(analysis.shouldMute, true);
});

test("PCM: the field double-talk profile (corr 0.76–0.83, mic louder than reference) reads as double_talk and does NOT mute", () => {
  const detector = new MeetingEchoLeakDetector();
  const reference = fx.makeSeededNoise({ durationMs: REF_MS, amplitude: 0.2, seed: 21 });
  feedReference(detector, reference);
  // mic = 1.2·delayed reference + 0.9·independent local speech ⇒ corr = 1.2/√(1.44+0.81) = 0.8
  const bleed = delayedReferenceSlice(reference, 100, 1.2);
  const local = fx.scale(
    fx.makeSeededNoise({ durationMs: (CHUNK * 1000) / 24000, amplitude: 0.2, seed: 99 }),
    0.9
  );
  const mic = fx.mix(bleed, local);

  const analysis = detector.analyzeMicChunk(fx.toInt16Buffer(mic), REF_MS);

  assert.equal(analysis.state, "double_talk");
  assert.ok(
    analysis.correlation >= 0.72 && analysis.correlation <= 0.88,
    `corr ${analysis.correlation}`
  );
  assert.ok(
    analysis.residualRatio > 0.25 && analysis.residualRatio < 0.5,
    `residual ${analysis.residualRatio}`
  );
  assert.ok(
    analysis.micToSystemRatio > 1.3,
    `ratio ${analysis.micToSystemRatio} (louder than reference)`
  );
  assert.equal(analysis.shouldMute, false);
});

test("PCM: uncorrelated local speech reads clean_local with low correlation", () => {
  const detector = new MeetingEchoLeakDetector();
  const reference = fx.makeSeededNoise({ durationMs: REF_MS, amplitude: 0.2, seed: 31 });
  feedReference(detector, reference);
  const mic = fx.makeSeededNoise({ durationMs: (CHUNK * 1000) / 24000, amplitude: 0.2, seed: 77 });

  const analysis = detector.analyzeMicChunk(fx.toInt16Buffer(mic), REF_MS);

  assert.equal(analysis.state, "clean_local");
  assert.ok(analysis.correlation < 0.3, `corr ${analysis.correlation}`);
  assert.equal(analysis.shouldMute, false);
});

test("PCM (limitation): a bleed copy whose delay falls off the 5 ms lag grid is not detected", () => {
  const detector = new MeetingEchoLeakDetector();
  const reference = fx.makeSeededNoise({ durationMs: REF_MS, amplitude: 0.2, seed: 41 });
  feedReference(detector, reference);
  const mic = delayedReferenceSlice(reference, 102.5, fx.dbToGain(-12)); // 2460 samples: 60 off the 120-sample grid

  const analysis = detector.analyzeMicChunk(fx.toInt16Buffer(mic), REF_MS);

  assert.equal(
    analysis.state,
    "clean_local",
    "white-noise bleed 60 samples off-grid decorrelates completely"
  );
  assert.ok(analysis.correlation < 0.3, `corr ${analysis.correlation}`);
});

test("PCM (limitation): a bleed copy below MIN_RMS is returned unanalyzed as clean_local", () => {
  const detector = new MeetingEchoLeakDetector();
  const reference = fx.makeSeededNoise({ durationMs: REF_MS, amplitude: 0.2, seed: 51 });
  feedReference(detector, reference);
  const mic = delayedReferenceSlice(reference, 100, 0.04); // rms ≈ 0.0046 < 0.006

  const analysis = detector.analyzeMicChunk(fx.toInt16Buffer(mic), REF_MS);

  assert.ok(analysis.rms < 0.006, `rms ${analysis.rms}`);
  assert.equal(analysis.state, "clean_local");
  assert.equal(analysis.correlation, 0);
  assert.equal(analysis.shouldMute, false);
});
