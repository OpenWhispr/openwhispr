const test = require("node:test");
const assert = require("node:assert/strict");

const createMeetingAutoEndController = require("../../src/helpers/meetingAutoEndController");
const {
  SILENCE_WINDOW_MS,
  FAST_SILENCE_MS,
  OWNERSHIP_MIN_ACTIVE_MS,
  OWNERSHIP_CONFIRM_MS,
  TICK_GAP_MS,
} = createMeetingAutoEndController;

const START_TIME = 1_000_000;
const TICK_MS = 1_000;

const createHarness = () => {
  let now = START_TIME;
  const stops = [];
  const controller = createMeetingAutoEndController({
    now: () => now,
    onStop: (sessionId, reason) => stops.push({ sessionId, reason }),
  });

  const runFor = (ms) => {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(TICK_MS, remaining);
      now += step;
      remaining -= step;
      controller.tick();
    }
  };

  return {
    controller,
    stops,
    runFor,
    jump: (ms) => {
      now += ms;
    },
  };
};

const beginOwnership = (controller, sessionId = "s1") =>
  controller.beginSession({ sessionId, eligible: true, reliable: true, externalMicActive: true });

const beginFallback = (controller, sessionId = "s1", { reliable = true } = {}) =>
  controller.beginSession({ sessionId, eligible: true, reliable, externalMicActive: false });

const micReleased = (controller, sessionId = "s1") =>
  controller.handleExternalMicState({ sessionId, reliable: true, externalMicActive: false });

const micAcquired = (controller, sessionId = "s1") =>
  controller.handleExternalMicState({ sessionId, reliable: true, externalMicActive: true });

const audio = (controller, micActive, systemActive, sessionId = "s1") =>
  controller.handleAudioActivity({ sessionId, micActive, systemActive });

test("ownership: a qualifying mic release stops after the confirm window", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  assert.deepEqual(harness.stops, []);
  harness.runFor(OWNERSHIP_CONFIRM_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);

  harness.runFor(TICK_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

// A device flap (Bluetooth reconnect, input-device switch, an app rebuilding
// its input unit for screen share) emits MIC_STOP then MIC_START in the same
// reconcile pass, with no time between them.
test("ownership: a mic release immediately followed by a re-acquire keeps recording", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  micAcquired(harness.controller);

  harness.runFor(4 * OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.stops, []);
});

test("ownership: remote audio during the confirm window restarts it", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS - TICK_MS);
  audio(harness.controller, false, true);
  harness.runFor(4 * OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.stops, []);

  audio(harness.controller, false, false);
  harness.runFor(OWNERSHIP_CONFIRM_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);

  harness.runFor(TICK_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: remote audio defers stopping until the system channel goes quiet", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  audio(harness.controller, false, true);

  micReleased(harness.controller);
  harness.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(harness.stops, []);

  audio(harness.controller, false, false);
  harness.runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: mic-channel activity does not mask a qualifying release", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  audio(harness.controller, true, false);

  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: a brief external mic hold falls back to the silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  audio(harness.controller, true, false);
  micAcquired(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS - TICK_MS);

  micReleased(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS);
  assert.deepEqual(harness.stops, []);

  audio(harness.controller, false, false);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);
  harness.runFor(TICK_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("ownership: process exit is ignored while an app owns the mic", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(2 * SILENCE_WINDOW_MS);

  assert.deepEqual(harness.stops, []);
});

test("fallback: both channels staying quiet for 60 seconds stops immediately", () => {
  const harness = createHarness();
  beginFallback(harness.controller);

  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: activity on either channel restarts the silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - 5_000);

  audio(harness.controller, true, false);
  harness.runFor(5_000);
  audio(harness.controller, false, false);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: process exit shortens the quiet window to 10 seconds", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(20_000);

  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(FAST_SILENCE_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "process-exit" }]);
});

test("fallback: activity after process exit restores the full silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(5_000);

  audio(harness.controller, false, true);
  harness.runFor(5_000);
  audio(harness.controller, false, false);
  harness.runFor(FAST_SILENCE_MS);
  assert.deepEqual(harness.stops, []);

  harness.runFor(SILENCE_WINDOW_MS - FAST_SILENCE_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: a session with no chunks still stops after the silence window", () => {
  const harness = createHarness();
  beginFallback(harness.controller);

  harness.runFor(SILENCE_WINDOW_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: unreliable ownership uses the silence window from session start", () => {
  const harness = createHarness();
  beginFallback(harness.controller, "s1", { reliable: false });

  harness.runFor(SILENCE_WINDOW_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("mode transitions: fresh ownership switches fallback into ownership mode", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);

  micAcquired(harness.controller);
  harness.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(harness.stops, []);

  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("mode transitions: reliability loss restarts fallback silence from that moment", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  harness.controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("mode transitions: an inactive reliable report after reliability loss stays fallback", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  harness.controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  harness.runFor(5_000);

  micReleased(harness.controller);
  assert.deepEqual(harness.stops, []);
  harness.runFor(SILENCE_WINDOW_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("clock: a sleep-sized tick gap discards accumulated silence", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);

  harness.jump(TICK_GAP_MS + 1);
  harness.controller.tick();
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);
  harness.runFor(TICK_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

// Every entry point observes the clock, not just tick(): after wake the owner's
// monitor can deliver an activity change before the controller's own tick runs,
// and that path has to discard the pre-sleep silence too.
test("clock: a sleep-sized gap observed through an activity event discards accumulated silence", () => {
  const harness = createHarness();
  beginFallback(harness.controller);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);

  harness.jump(TICK_GAP_MS + 1);
  audio(harness.controller, false, false);

  assert.deepEqual(harness.stops, []);
  harness.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(harness.stops, []);

  harness.runFor(TICK_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "silence" }]);
});

// endSession drops the session outright, so evidence gathered before it can
// never drive a stop afterwards. Every _deactivateAutoEnd goes through here.
test("ending a session keeps its pending evidence from stopping anything later", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(harness.controller);

  harness.controller.endSession("s1");
  harness.runFor(OWNERSHIP_CONFIRM_MS + SILENCE_WINDOW_MS);

  assert.deepEqual(harness.stops, []);
});

test("ending a session that is not the live one leaves the live one running", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(harness.controller);

  harness.controller.endSession("s2");
  harness.runFor(OWNERSHIP_CONFIRM_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("clock: a mic release observed on wake does not stop immediately", () => {
  const { controller, jump, runFor, stops } = createHarness();
  beginOwnership(controller);
  runFor(OWNERSHIP_MIN_ACTIVE_MS);

  jump(TICK_GAP_MS + 1);
  controller.handleExternalMicState({
    sessionId: "s1",
    reliable: true,
    externalMicActive: false,
  });

  assert.deepEqual(stops, []);
  runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(stops, []);
  runFor(TICK_MS);
  assert.deepEqual(stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("lifecycle: a stop fires once and later inputs are ignored", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(harness.controller);
  harness.runFor(OWNERSHIP_CONFIRM_MS);

  micAcquired(harness.controller);
  micReleased(harness.controller);
  audio(harness.controller, true, true);
  audio(harness.controller, false, false);
  harness.controller.handleMeetingProcessExit({ sessionId: "s1" });
  harness.runFor(5 * SILENCE_WINDOW_MS);

  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("guards: stale session ids and ineligible sessions ignore inputs", () => {
  const harness = createHarness();
  beginOwnership(harness.controller);
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller, "other");
  audio(harness.controller, false, false, "other");
  harness.controller.handleMeetingProcessExit({ sessionId: "other" });
  assert.deepEqual(harness.stops, []);

  harness.controller.beginSession({
    sessionId: "s2",
    eligible: false,
    reliable: true,
    externalMicActive: true,
  });
  micReleased(harness.controller, "s2");
  harness.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(harness.stops, []);
});

test("initial state: an already-audible system channel defers ownership stop", () => {
  const harness = createHarness();
  harness.controller.beginSession({
    sessionId: "s1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
    micActive: false,
    systemActive: true,
  });
  harness.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(harness.controller);
  assert.deepEqual(harness.stops, []);

  audio(harness.controller, false, false);
  harness.runFor(OWNERSHIP_CONFIRM_MS);
  assert.deepEqual(harness.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});
