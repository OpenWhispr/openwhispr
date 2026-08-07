const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      shell: { openExternal: async () => undefined },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");
const createMeetingAutoEndController = require("../../src/helpers/meetingAutoEndController");
Module._load = originalLoad;

const createClock = () => {
  let now = 10_000;
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
    pendingTimers: () => [...timers.entries()],
    run: (timerId) => {
      const timer = timers.get(timerId);
      if (!timer) return;
      timers.delete(timerId);
      timer.callback();
    },
  };
};

class FakeAudioActivityDetector extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.startCount = 0;
    this.stopCount = 0;
    this.externalMicState = { reliable: true, externalMicActive: true };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startCount += 1;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.stopCount += 1;
  }

  getExternalMicState() {
    return { ...this.externalMicState };
  }

  setUserRecording() {}
  resetPrompt() {}
  dismiss() {}
}

class FakeMeetingProcessDetector extends EventEmitter {
  start() {}
  stop() {}
}

function createEngine() {
  const clock = createClock();
  const audioActivityDetector = new FakeAudioActivityDetector();
  const shownCountdowns = [];
  const dismissedCountdowns = [];
  const shownNotifications = [];
  const windowManager = {
    notificationPrefs: {},
    showMeetingAutoEndCountdown: (countdown) => shownCountdowns.push(countdown),
    dismissMeetingAutoEndCountdown: (sessionId) => dismissedCountdowns.push(sessionId),
    showMeetingNotification: (notification) => shownNotifications.push(notification),
  };
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    new FakeMeetingProcessDetector(),
    audioActivityDetector,
    windowManager,
    {},
    {
      createAutoEndController: (callbacks) =>
        createMeetingAutoEndController({
          ...callbacks,
          now: clock.now,
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
        }),
    }
  );

  return {
    audioActivityDetector,
    clock,
    dismissedCountdowns,
    engine,
    shownCountdowns,
    shownNotifications,
  };
}

test("detection prompts retain their existing payload with a detection discriminator", () => {
  const { engine, shownNotifications } = createEngine();
  const event = {
    id: "calendar-1",
    summary: "Planning",
    start_time: new Date(9_000).toISOString(),
  };

  engine.handleCalendarReminder(event);

  assert.deepEqual(shownNotifications, [
    {
      kind: "detection",
      detectionId: "calendar:calendar-1",
      source: "calendar",
      key: "calendar-1",
      event,
      variant: "underway",
      joinUrl: null,
    },
  ]);
  engine.stop();
});

test("keeps audio ownership detection running while an eligible recording is active", async () => {
  const { audioActivityDetector, engine } = createEngine();

  engine.setPreferences({ audioDetection: false });
  assert.equal(audioActivityDetector.running, false);

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => undefined },
  });
  assert.equal(audioActivityDetector.running, true);

  engine.setPreferences({ audioDetection: false });
  assert.equal(audioActivityDetector.running, true);

  assert.equal(engine.endRecordingSession("meeting-1"), true);
  assert.equal(audioActivityDetector.running, false);
});

test("shows and dismisses the countdown from reliable external mic changes", async () => {
  const { audioActivityDetector, dismissedCountdowns, engine, shownCountdowns } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => undefined },
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: true,
  });

  assert.deepEqual(shownCountdowns, [{ sessionId: "meeting-1", expiresAt: 70_000 }]);
  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  engine.stop();
});

test("reliability loss dismisses the countdown and prevents auto-stop", async () => {
  const { audioActivityDetector, clock, dismissedCountdowns, engine } = createEngine();
  const messages = [];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: {
      isDestroyed: () => false,
      send: (channel, payload) => messages.push({ channel, payload }),
    },
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });
  const [[timerId]] = clock.pendingTimers();

  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: false,
    externalMicActive: false,
  });
  clock.run(timerId);

  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  assert.deepEqual(messages, []);
  engine.stop();
});

test("expiry requests one stop from the renderer that owns the current session", async () => {
  const { audioActivityDetector, clock, engine } = createEngine();
  const messages = [];
  const ownerWebContents = {
    isDestroyed: () => false,
    send: (channel, payload) => messages.push({ channel, payload }),
  };

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents,
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });
  const [[timerId]] = clock.pendingTimers();
  clock.run(timerId);
  clock.run(timerId);

  assert.deepEqual(messages, [
    {
      channel: "meeting-auto-end-requested",
      payload: { sessionId: "meeting-1" },
    },
  ]);
  engine.stop();
});

test("replacement cancels the old countdown and stale end requests preserve the new session", async () => {
  const { audioActivityDetector, clock, dismissedCountdowns, engine } = createEngine();
  const messages = [];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => messages.push("meeting-1") },
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });
  const [[oldTimerId]] = clock.pendingTimers();

  await engine.beginRecordingSession({
    sessionId: "meeting-2",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => messages.push("meeting-2") },
  });
  assert.equal(engine.endRecordingSession("meeting-1"), false);
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });
  const [[newTimerId]] = clock.pendingTimers();

  clock.run(oldTimerId);
  clock.run(newTimerId);

  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  assert.deepEqual(messages, ["meeting-2"]);
  engine.stop();
});

test("an ineligible recording does not retain the audio detector", async () => {
  const { audioActivityDetector, engine, shownCountdowns } = createEngine();

  engine.setPreferences({ audioDetection: false });
  await engine.beginRecordingSession({
    sessionId: "personal-1",
    autoEndEligible: false,
    ownerWebContents: { isDestroyed: () => false, send: () => undefined },
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });

  assert.equal(audioActivityDetector.running, false);
  assert.deepEqual(shownCountdowns, []);
  assert.equal(engine.endRecordingSession("personal-1"), true);
});

test("keep recording disables auto-end only for the matching session", async () => {
  const { audioActivityDetector, dismissedCountdowns, engine, shownCountdowns } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => undefined },
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });

  assert.equal(engine.keepRecordingSession("stale-session"), false);
  assert.equal(engine.keepRecordingSession("meeting-1"), true);
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: true,
  });
  audioActivityDetector.emit("external-mic-state-changed", {
    reliable: true,
    externalMicActive: false,
  });

  assert.equal(shownCountdowns.length, 1);
  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  engine.stop();
});
