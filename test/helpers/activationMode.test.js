const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HYBRID_TAP_THRESHOLD_MS,
  normalizeActivationMode,
  usesKeyRelease,
  toHotkeyRegistrationMode,
  resolveDictationPress,
  resolveDictationRelease,
} = require("../../src/helpers/activationMode");

test("unknown modes normalize to tap; hybrid survives", () => {
  assert.equal(normalizeActivationMode("hybrid"), "hybrid");
  assert.equal(normalizeActivationMode("push"), "push");
  assert.equal(normalizeActivationMode("tap"), "tap");
  assert.equal(normalizeActivationMode(undefined), "tap");
  assert.equal(normalizeActivationMode("bogus"), "tap");
});

test("hybrid needs key-release plumbing and registers as push", () => {
  assert.equal(usesKeyRelease("tap"), false);
  assert.equal(usesKeyRelease("push"), true);
  assert.equal(usesKeyRelease("hybrid"), true);
  assert.equal(toHotkeyRegistrationMode("hybrid"), "push");
  assert.equal(toHotkeyRegistrationMode("tap"), "tap");
});

test("press: tap toggles, push holds, hybrid holds unless a latched recording runs", () => {
  assert.equal(resolveDictationPress({ mode: "tap", isRecording: false }), "toggle");
  assert.equal(resolveDictationPress({ mode: "tap", isRecording: true }), "toggle");
  assert.equal(resolveDictationPress({ mode: "push", isRecording: false }), "hold");
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: false }), "hold");
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: true }), "stop");
});

test("release in push mode: stop when recording, cancel otherwise", () => {
  assert.equal(resolveDictationRelease({ mode: "push", heldMs: 50, isRecording: false }), "cancel");
  assert.equal(resolveDictationRelease({ mode: "push", heldMs: 50, isRecording: true }), "stop");
  assert.equal(resolveDictationRelease({ mode: "push", heldMs: 2000, isRecording: true }), "stop");
});

test("release in hybrid mode: short press latches, long press stops", () => {
  const below = HYBRID_TAP_THRESHOLD_MS - 1;
  const atThreshold = HYBRID_TAP_THRESHOLD_MS;
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 80, isRecording: false }),
    "latch"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: below, isRecording: true }),
    "latch"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: atThreshold, isRecording: true }),
    "stop"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 5000, isRecording: true }),
    "stop"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 5000, isRecording: false }),
    "cancel"
  );
});

test("a forced release (listener reset, safety timeout) never latches", () => {
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 10, isRecording: true, force: true }),
    "stop"
  );
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 10, isRecording: false, force: true }),
    "cancel"
  );
});

test("a tap-latch-tap cycle on one key", () => {
  // First tap: press with nothing running -> hold state machine; release at 120 ms latches.
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: false }), "hold");
  assert.equal(
    resolveDictationRelease({ mode: "hybrid", heldMs: 120, isRecording: true }),
    "latch"
  );
  // Second tap: press with the latched recording running -> stop.
  assert.equal(resolveDictationPress({ mode: "hybrid", isRecording: true }), "stop");
});
