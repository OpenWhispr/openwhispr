const test = require("node:test");
const assert = require("node:assert/strict");

test("fails open when no windows were recorded", async () => {
  const { createLocalSpeechGateState, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  assert.deepEqual(getLocalSpeechGateDecision(createLocalSpeechGateState()), {
    skip: false,
    reason: "unavailable",
  });
  assert.deepEqual(getLocalSpeechGateDecision(null), { skip: false, reason: "unavailable" });
});

test("treats near silence as skippable", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0012, 0.01);
  recordLocalSpeechWindow(state, 0.0016, 0.015);
  recordLocalSpeechWindow(state, 0.0014, 0.012);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: true,
    reason: "silence",
    peakRms: 0.0016,
    peakAmplitude: 0.015,
    windowCount: 3,
    speechWindowCount: 0,
    maxConsecutiveSpeechWindows: 0,
  });
});

test("rejects isolated noise bursts without sustained speech", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  // All windows have energy above silence but below speech thresholds
  recordLocalSpeechWindow(state, 0.0025, 0.015);
  recordLocalSpeechWindow(state, 0.0028, 0.018);
  recordLocalSpeechWindow(state, 0.0022, 0.014);

  const decision = getLocalSpeechGateDecision(state);

  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "insufficient_speech");
  assert.equal(decision.peakRms, 0.0028);
  assert.equal(decision.peakAmplitude, 0.018);
  assert.equal(decision.windowCount, 3);
  assert.equal(decision.speechWindowCount, 0);
  assert.equal(decision.maxConsecutiveSpeechWindows, 0);
});

test("allows sustained speech-like energy through", async () => {
  const { createLocalSpeechGateState, recordLocalSpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.003, 0.025);
  recordLocalSpeechWindow(state, 0.0056, 0.06);
  recordLocalSpeechWindow(state, 0.0061, 0.065);

  assert.deepEqual(getLocalSpeechGateDecision(state), {
    skip: false,
    reason: "speech_detected",
    peakRms: 0.0061,
    peakAmplitude: 0.065,
    windowCount: 3,
    speechWindowCount: 3,
    maxConsecutiveSpeechWindows: 3,
  });
});

test("measures a PCM16 chunk as one window", async () => {
  const { createLocalSpeechGateState, recordPcm16SpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  const silent = createLocalSpeechGateState();
  recordPcm16SpeechWindow(silent, new Int16Array(800).buffer);
  assert.equal(getLocalSpeechGateDecision(silent).reason, "silence");

  const speech = createLocalSpeechGateState();
  recordPcm16SpeechWindow(speech, new Int16Array([16384, -16384, 16384, -16384]).buffer);
  assert.deepEqual(getLocalSpeechGateDecision(speech), {
    skip: false,
    reason: "speech_detected",
    peakRms: 0.5,
    peakAmplitude: 0.5,
    windowCount: 1,
    speechWindowCount: 1,
    maxConsecutiveSpeechWindows: 1,
  });
});

test("reads a quiet PCM16 chunk at the batch analyser's 8-bit resolution", async () => {
  const { createLocalSpeechGateState, recordPcm16SpeechWindow, getLocalSpeechGateDecision } =
    await import("../../src/helpers/localSpeechGate.js");

  // ±40 is about -58 dBFS. The analyser's byte samples floor every negative
  // sample to -1/128 and every small positive one to 0, so batch measures
  // (1/128)·√½ and never calls this silence.
  const state = createLocalSpeechGateState();
  recordPcm16SpeechWindow(state, new Int16Array([40, -40, 40, -40]).buffer);
  const decision = getLocalSpeechGateDecision(state);

  assert.equal(decision.reason, "insufficient_speech");
  assert.ok(Math.abs(decision.peakRms - 0.0055243) < 1e-6, `peakRms ${decision.peakRms}`);
  assert.equal(decision.peakAmplitude, 0.0078125);
});
