const test = require("node:test");
const assert = require("node:assert/strict");

test("treats near silence as skippable", async () => {
  const {
    createLocalSpeechGateState,
    recordLocalSpeechWindow,
    getLocalSpeechGateDecision,
  } = await import("../../src/helpers/localSpeechGate.js");

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
  const {
    createLocalSpeechGateState,
    recordLocalSpeechWindow,
    getLocalSpeechGateDecision,
  } = await import("../../src/helpers/localSpeechGate.js");

  const state = createLocalSpeechGateState();
  recordLocalSpeechWindow(state, 0.0025, 0.03);
  recordLocalSpeechWindow(state, 0.0052, 0.045);
  recordLocalSpeechWindow(state, 0.0028, 0.028);

  const decision = getLocalSpeechGateDecision(state);

  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "insufficient_speech");
  assert.equal(decision.peakRms, 0.0052);
  assert.equal(decision.peakAmplitude, 0.045);
  assert.equal(decision.windowCount, 3);
  assert.equal(decision.speechWindowCount, 1);
  assert.equal(decision.maxConsecutiveSpeechWindows, 1);
});

test("allows sustained speech-like energy through", async () => {
  const {
    createLocalSpeechGateState,
    recordLocalSpeechWindow,
    getLocalSpeechGateDecision,
  } = await import("../../src/helpers/localSpeechGate.js");

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
    speechWindowCount: 2,
    maxConsecutiveSpeechWindows: 2,
  });
});
