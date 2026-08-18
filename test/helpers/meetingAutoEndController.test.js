const test = require("node:test");
const assert = require("node:assert/strict");

const createMeetingAutoEndController = require("../../src/helpers/meetingAutoEndController");
const {
  COUNTDOWN_MS,
  SILENCE_WINDOW_MS,
  FAST_SILENCE_MS,
  KEEP_COOLDOWN_MS,
  OWNERSHIP_MIN_ACTIVE_MS,
  TICK_GAP_MS,
} = createMeetingAutoEndController;

const START_TIME = 1_000_000;
const TICK_MS = 1_000;

// The engine ticks the controller about once a second; runFor() mirrors that so
// long spans never look like a sleep gap.
const createHarness = () => {
  let now = START_TIME;
  const countdowns = [];
  const canceledCountdowns = [];
  const stops = [];
  const controller = createMeetingAutoEndController({
    now: () => now,
    onCountdown: (countdown) => countdowns.push(countdown),
    onCountdownCanceled: (sessionId) => canceledCountdowns.push(sessionId),
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
  const jump = (ms) => {
    now += ms;
  };

  return {
    controller,
    countdowns,
    canceledCountdowns,
    stops,
    runFor,
    jump,
    now: () => now,
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

// --------------------------------------------------------------------------
// Ownership mode
// --------------------------------------------------------------------------

test("ownership: mic release with a quiet system channel starts a mic-released countdown", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(h.controller);

  assert.deepEqual(h.countdowns, [
    { sessionId: "s1", expiresAt: h.now() + COUNTDOWN_MS, reason: "mic-released" },
  ]);
  h.runFor(COUNTDOWN_MS - TICK_MS);
  assert.deepEqual(h.stops, []);
  h.runFor(TICK_MS);
  assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: audible system audio defers the countdown until it goes quiet", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  audio(h.controller, false, true);

  micReleased(h.controller);
  h.runFor(2 * COUNTDOWN_MS);
  assert.deepEqual(h.countdowns, [], "remote voices still playing — call is live");

  audio(h.controller, false, false);
  assert.equal(h.countdowns.length, 1);
  assert.equal(h.countdowns[0].reason, "mic-released");
});

test("ownership: system audio resuming cancels the countdown and quiet restarts it from 60s", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.runFor(30_000);

  audio(h.controller, false, true);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(COUNTDOWN_MS);
  assert.deepEqual(h.stops, []);

  audio(h.controller, false, false);
  assert.equal(h.countdowns.length, 2);
  assert.equal(h.countdowns[1].expiresAt, h.now() + COUNTDOWN_MS, "full 60s again");
});

test("ownership: a re-acquired external mic cancels the countdown and re-arms", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.runFor(30_000);

  micAcquired(h.controller);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(2 * COUNTDOWN_MS);
  assert.deepEqual(h.stops, []);

  micReleased(h.controller);
  assert.equal(h.countdowns.length, 2);
});

test("ownership: mic-channel activity does not cancel the countdown", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);

  audio(h.controller, true, false);
  h.runFor(COUNTDOWN_MS);

  assert.deepEqual(h.canceledCountdowns, []);
  assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "mic-released" }]);
});

test("ownership: a hold shorter than the minimum falls back to silence instead of arming", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(20_000);
  audio(h.controller, true, false);
  micAcquired(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS - TICK_MS);

  micReleased(h.controller);
  h.runFor(2 * COUNTDOWN_MS);

  assert.deepEqual(h.countdowns, [], "people are still talking in the room");
  audio(h.controller, false, false);
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1);
  assert.equal(h.countdowns[0].reason, "silence");
});

test("ownership: a process exit is ignored", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  h.controller.handleMeetingProcessExit({ sessionId: "s1" });
  h.runFor(2 * SILENCE_WINDOW_MS);

  assert.deepEqual(h.countdowns, []);
});

test("ownership: keep suppresses prompts until fresh active ownership, and the cooldown still applies", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);

  assert.equal(h.controller.keepRecording("s1"), true);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(2 * KEEP_COOLDOWN_MS);
  assert.equal(h.countdowns.length, 1, "no further call → never re-prompted");

  micAcquired(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  assert.equal(h.countdowns.length, 2, "a new call is fresh evidence");
});

test("ownership: a call rejoined and left again re-prompts at once, even inside the keep cooldown", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.controller.keepRecording("s1");

  h.runFor(60_000);
  micAcquired(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);

  assert.equal(h.countdowns.length, 2, "unambiguous evidence must not wait out the cooldown");
  assert.equal(h.countdowns[1].reason, "mic-released");
});

test("ownership: a brief rejoin inside the cooldown does not bypass it", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.controller.keepRecording("s1");
  const keptAt = h.now();

  h.runFor(60_000);
  micAcquired(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS - TICK_MS);
  micReleased(h.controller);
  h.runFor(2 * SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1, "an incidental hold is not fresh evidence");

  h.runFor(keptAt + KEEP_COOLDOWN_MS - h.now());
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 2, "after the cooldown, silence prompts as fallback");
  assert.equal(h.countdowns[1].reason, "silence");
});

// --------------------------------------------------------------------------
// Fallback mode
// --------------------------------------------------------------------------

test("fallback: 60s of both-channel silence prompts with reason silence", () => {
  const h = createHarness();
  beginFallback(h.controller);

  h.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(h.countdowns, []);
  h.runFor(TICK_MS);

  assert.deepEqual(h.countdowns, [
    { sessionId: "s1", expiresAt: h.now() + COUNTDOWN_MS, reason: "silence" },
  ]);
  h.runFor(COUNTDOWN_MS);
  assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "silence" }]);
});

test("fallback: activity on either channel resets the window and cancels the countdown", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS - 5_000);

  audio(h.controller, true, false);
  h.runFor(5_000);
  audio(h.controller, false, false);
  h.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.deepEqual(h.countdowns, [], "the window restarted when the mic went quiet");
  h.runFor(TICK_MS);
  assert.equal(h.countdowns.length, 1);

  audio(h.controller, false, true);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(2 * COUNTDOWN_MS);
  assert.deepEqual(h.stops, []);
});

test("fallback: process exit with no tracked app left shortens the window to 10s", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(20_000);

  h.controller.handleMeetingProcessExit({ sessionId: "s1" });
  h.runFor(FAST_SILENCE_MS - TICK_MS);
  assert.deepEqual(h.countdowns, []);
  h.runFor(TICK_MS);

  assert.equal(h.countdowns.length, 1);
  assert.equal(h.countdowns[0].reason, "process-exit");
});

test("fallback: activity after a process exit clears the fast window", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.controller.handleMeetingProcessExit({ sessionId: "s1" });
  h.runFor(5_000);

  audio(h.controller, false, true);
  h.runFor(5_000);
  audio(h.controller, false, false);
  h.runFor(FAST_SILENCE_MS);
  assert.deepEqual(h.countdowns, [], "call continued elsewhere — back to the full window");

  h.runFor(SILENCE_WINDOW_MS - FAST_SILENCE_MS);
  assert.equal(h.countdowns.length, 1);
  assert.equal(h.countdowns[0].reason, "silence");
});

test("fallback: process exit while a countdown is visible is ignored", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1);
  const { expiresAt } = h.countdowns[0];

  h.controller.handleMeetingProcessExit({ sessionId: "s1" });
  h.runFor(COUNTDOWN_MS);

  assert.equal(h.countdowns.length, 1);
  assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "silence" }]);
  assert.equal(h.countdowns[0].expiresAt, expiresAt);
});

test("fallback: keep is honored until activity resumes and the cooldown passes", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.controller.keepRecording("s1"), true);
  const keptAt = h.now();

  h.runFor(2 * KEEP_COOLDOWN_MS);
  assert.equal(h.countdowns.length, 1, "no fresh evidence → no re-prompt");

  audio(h.controller, true, false);
  h.runFor(2_000);
  audio(h.controller, false, false);
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 2, "renewed audio then silence reopened the episode");
  assert.ok(h.countdowns[1].expiresAt > keptAt + KEEP_COOLDOWN_MS);
});

test("fallback: process exit after keep reopens the episode but fires no earlier than the cooldown", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS);
  h.controller.keepRecording("s1");
  const keptAt = h.now();

  h.runFor(60_000);
  h.controller.handleMeetingProcessExit({ sessionId: "s1" });
  h.runFor(FAST_SILENCE_MS + TICK_MS);
  assert.equal(h.countdowns.length, 1, "inside the cooldown");

  h.runFor(keptAt + KEEP_COOLDOWN_MS - h.now());
  assert.equal(h.countdowns.length, 2);
  assert.equal(h.countdowns[1].reason, "process-exit");
});

test("fallback: a session that never sees a chunk prompts after the first window", () => {
  const h = createHarness();
  beginFallback(h.controller);

  h.runFor(SILENCE_WINDOW_MS);

  assert.equal(h.countdowns.length, 1);
  assert.equal(h.countdowns[0].reason, "silence");
});

test("fallback: unreliable ownership behaves as fallback from the start", () => {
  const h = createHarness();
  beginFallback(h.controller, "s1", { reliable: false });

  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1);
});

// --------------------------------------------------------------------------
// Mode transitions
// --------------------------------------------------------------------------

test("fresh active ownership switches fallback to ownership and cancels a pending fallback countdown", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1);

  micAcquired(h.controller);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(2 * SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1, "silence no longer prompts while an app holds the mic");

  micReleased(h.controller);
  assert.equal(h.countdowns.length, 2);
  assert.equal(h.countdowns[1].reason, "mic-released");
});

test("reliability loss switches to fallback, dismisses the countdown, and restarts silence from now", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.runFor(30_000);

  h.controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  assert.deepEqual(h.canceledCountdowns, ["s1"]);

  h.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.equal(h.countdowns.length, 1);
  h.runFor(TICK_MS);
  assert.equal(h.countdowns.length, 2);
  assert.equal(h.countdowns[1].reason, "silence");
});

test("a reliable-but-inactive report after a reliability loss stays in fallback", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  h.controller.handleExternalMicState({
    sessionId: "s1",
    reliable: false,
    externalMicActive: false,
  });
  h.runFor(5_000);

  micReleased(h.controller);
  assert.deepEqual(
    h.countdowns,
    [],
    "no observed release → must not start a mic-released countdown"
  );

  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1);
  assert.equal(h.countdowns[0].reason, "silence");
});

// --------------------------------------------------------------------------
// Clock, lifecycle, and guards
// --------------------------------------------------------------------------

test("a tick gap over the sleep threshold discards accumulated silence and cancels a visible countdown without stopping", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS);
  assert.equal(h.countdowns.length, 1);

  h.jump(8 * 60 * 60 * 1000);
  h.controller.tick();

  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(SILENCE_WINDOW_MS - TICK_MS);
  assert.equal(h.countdowns.length, 1, "silence restarted from wake");
  h.runFor(TICK_MS);
  assert.equal(h.countdowns.length, 2);
});

test("a gap observed through an activity event instead of tick() is handled the same way", () => {
  const h = createHarness();
  beginFallback(h.controller);
  h.runFor(SILENCE_WINDOW_MS);
  h.runFor(30_000);

  h.jump(TICK_GAP_MS + 1);
  audio(h.controller, false, false);

  assert.deepEqual(h.stops, []);
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
});

test("countdown expiry stops exactly once and later inputs are ignored", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.runFor(COUNTDOWN_MS);
  assert.equal(h.stops.length, 1);

  h.runFor(5 * COUNTDOWN_MS);
  micAcquired(h.controller);
  micReleased(h.controller);
  audio(h.controller, true, true);
  audio(h.controller, false, false);
  h.controller.handleMeetingProcessExit({ sessionId: "s1" });
  h.runFor(5 * COUNTDOWN_MS);

  assert.equal(h.stops.length, 1);
  assert.equal(h.countdowns.length, 1);
});

test("keep recording after countdown expiry reports failure — the stop is already in flight", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.runFor(COUNTDOWN_MS);

  assert.equal(h.controller.keepRecording("s1"), false);
});

test("ending or replacing a session cancels its countdown", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  assert.equal(h.countdowns.length, 1);

  beginOwnership(h.controller, "s2");
  assert.deepEqual(h.canceledCountdowns, ["s1"]);
  h.runFor(2 * COUNTDOWN_MS);
  assert.deepEqual(h.stops, [], "the old countdown never fires for the new session");

  micReleased(h.controller, "s2");
  h.controller.endSession("s2");
  assert.deepEqual(h.canceledCountdowns, ["s1", "s2"]);
  h.runFor(2 * COUNTDOWN_MS);
  assert.deepEqual(h.stops, []);
});

test("ending an expired session dismisses nothing and does not stop again", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);
  micReleased(h.controller);
  h.runFor(COUNTDOWN_MS);

  h.controller.endSession("s1");
  h.runFor(COUNTDOWN_MS);

  assert.equal(h.stops.length, 1);
  assert.deepEqual(h.canceledCountdowns, []);
});

test("stale session ids and ineligible sessions ignore all inputs", () => {
  const h = createHarness();
  beginOwnership(h.controller);
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(h.controller, "other");
  audio(h.controller, false, false, "other");
  h.controller.handleMeetingProcessExit({ sessionId: "other" });
  assert.equal(h.controller.keepRecording("other"), false);
  h.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(h.countdowns, []);

  h.controller.beginSession({
    sessionId: "s3",
    eligible: false,
    reliable: true,
    externalMicActive: true,
  });
  micReleased(h.controller, "s3");
  h.runFor(2 * SILENCE_WINDOW_MS);
  assert.deepEqual(h.countdowns, []);
});

test("beginSession seeds the initial audio state so an already-audible system channel defers the countdown", () => {
  const h = createHarness();
  h.controller.beginSession({
    sessionId: "s1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
    micActive: false,
    systemActive: true,
  });
  h.runFor(OWNERSHIP_MIN_ACTIVE_MS);

  micReleased(h.controller);
  h.runFor(COUNTDOWN_MS);
  assert.deepEqual(h.countdowns, []);

  audio(h.controller, false, false);
  assert.equal(h.countdowns.length, 1);
});
