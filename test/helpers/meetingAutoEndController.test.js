const test = require("node:test");
const assert = require("node:assert/strict");

const createMeetingAutoEndController = require("../../src/helpers/meetingAutoEndController");

const COUNTDOWN_MS = 60_000;
const START_TIME = 1_000_000;

const createClock = () => {
  let now = START_TIME;
  let nextTimerId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setTimeout: (callback, delay) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (timerId) => timers.delete(timerId),
    advance: (milliseconds) => {
      now += milliseconds;
    },
    pendingTimers: () => [...timers.entries()],
    run: (timerId) => {
      const timer = timers.get(timerId);
      if (!timer) return;

      timers.delete(timerId);
      timer.callback();
    },
  };
};

const createController = () => {
  const clock = createClock();
  const countdowns = [];
  const canceledCountdowns = [];
  const stops = [];
  const controller = createMeetingAutoEndController({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onCountdown: (countdown) => countdowns.push(countdown),
    onCountdownCanceled: (sessionId) => canceledCountdowns.push(sessionId),
    onStop: (sessionId) => stops.push(sessionId),
  });

  return { clock, controller, countdowns, canceledCountdowns, stops };
};

test("starts a 60-second countdown when an armed session becomes inactive", () => {
  const { clock, controller, countdowns } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.deepEqual(countdowns, [{ sessionId: "meeting-1", expiresAt: START_TIME + COUNTDOWN_MS }]);
  assert.deepEqual(
    clock.pendingTimers().map(([, timer]) => timer.delay),
    [COUNTDOWN_MS]
  );
});

test("a reliable active event arms an eligible session that began inactive", () => {
  const { controller, countdowns, clock } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: false,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.equal(countdowns.length, 1);
  assert.deepEqual(
    clock.pendingTimers().map(([, timer]) => timer.delay),
    [COUNTDOWN_MS]
  );
});

test("reactivation cancels the countdown and re-arms the session", () => {
  const { clock, controller, countdowns, canceledCountdowns, stops } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });
  const [[firstTimerId]] = clock.pendingTimers();

  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: true,
  });
  clock.run(firstTimerId);
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.deepEqual(stops, []);
  assert.deepEqual(canceledCountdowns, ["meeting-1"]);
  assert.equal(countdowns.length, 2);
  assert.equal(clock.pendingTimers().length, 1);
});

test("reliability loss cancels and disarms the countdown until fresh active ownership", () => {
  const { clock, controller, countdowns, canceledCountdowns, stops } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });
  const [[firstTimerId]] = clock.pendingTimers();

  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: false,
    externalMicActive: false,
  });
  clock.run(firstTimerId);
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.deepEqual(canceledCountdowns, ["meeting-1"]);
  assert.deepEqual(stops, []);
  assert.deepEqual(clock.pendingTimers(), []);

  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.equal(countdowns.length, 2);
  assert.equal(clock.pendingTimers().length, 1);
});

test("countdown expiry stops the current session exactly once", () => {
  const { clock, controller, stops } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });
  const [[timerId]] = clock.pendingTimers();
  clock.advance(COUNTDOWN_MS);
  clock.run(timerId);
  clock.run(timerId);

  assert.deepEqual(stops, ["meeting-1"]);
});

test("ending an expired session dismisses its still-visible countdown", () => {
  const { clock, controller, canceledCountdowns } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });
  const [[timerId]] = clock.pendingTimers();
  clock.run(timerId);

  controller.endSession("meeting-1");

  assert.deepEqual(canceledCountdowns, ["meeting-1"]);
});

test("keep recording cancels the countdown and disables auto-end for the session", () => {
  const { clock, controller, countdowns, stops } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });
  const [[timerId]] = clock.pendingTimers();

  controller.keepRecording("meeting-1");
  clock.run(timerId);
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.equal(countdowns.length, 1);
  assert.deepEqual(stops, []);
  assert.deepEqual(clock.pendingTimers(), []);
});

test("ending or replacing a session cancels its countdown", () => {
  const { clock, controller, stops } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: true,
    externalMicActive: false,
  });
  const [[firstTimerId]] = clock.pendingTimers();
  controller.endSession("meeting-1");
  clock.run(firstTimerId);

  controller.beginSession({
    sessionId: "meeting-2",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-2",
    reliable: true,
    externalMicActive: false,
  });
  const [[secondTimerId]] = clock.pendingTimers();
  controller.beginSession({
    sessionId: "meeting-3",
    eligible: true,
    reliable: true,
    externalMicActive: false,
  });
  clock.run(secondTimerId);

  assert.deepEqual(stops, []);
  assert.deepEqual(clock.pendingTimers(), []);
});

test("ignores stale or unreliable events and ineligible sessions", () => {
  const { clock, controller, countdowns } = createController();

  controller.beginSession({
    sessionId: "meeting-1",
    eligible: true,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "stale-session",
    reliable: true,
    externalMicActive: false,
  });
  controller.handleExternalMicState({
    sessionId: "meeting-1",
    reliable: false,
    externalMicActive: false,
  });
  controller.beginSession({
    sessionId: "personal-1",
    eligible: false,
    reliable: true,
    externalMicActive: true,
  });
  controller.handleExternalMicState({
    sessionId: "personal-1",
    reliable: true,
    externalMicActive: false,
  });

  assert.deepEqual(countdowns, []);
  assert.deepEqual(clock.pendingTimers(), []);
});
