const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
} = require("../../src/helpers/dictationLifecycle");

test("processing is the only lifecycle that suppresses a dictation hotkey", () => {
  assert.equal(shouldIgnoreDictationHotkey(DICTATION_LIFECYCLE.IDLE), false);
  assert.equal(shouldIgnoreDictationHotkey(DICTATION_LIFECYCLE.RECORDING), false);
  assert.equal(shouldIgnoreDictationHotkey(DICTATION_LIFECYCLE.PROCESSING), true);
});

test("main-process recording state follows confirmed renderer lifecycle", () => {
  assert.equal(isDictationRecording(DICTATION_LIFECYCLE.IDLE), false);
  assert.equal(isDictationRecording(DICTATION_LIFECYCLE.PROCESSING), false);
  assert.equal(isDictationRecording(DICTATION_LIFECYCLE.RECORDING), true);
});

test("unknown lifecycle input fails closed to idle", () => {
  assert.equal(normalizeDictationLifecycle("starting-a-new-recording"), DICTATION_LIFECYCLE.IDLE);
  assert.equal(shouldIgnoreDictationHotkey(undefined), false);
  assert.equal(isDictationRecording({}), false);
});
