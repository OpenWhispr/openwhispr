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

const { SILENCE_WINDOW_MS, FAST_SILENCE_MS, OWNERSHIP_MIN_ACTIVE_MS } =
  createMeetingAutoEndController;

const TICK_MS = 1000;
const RESTART_WINDOW_MS = 30_000;

const createClock = () => {
  let now = 10_000;
  const intervals = new Map();
  let nextIntervalId = 1;

  return {
    now: () => now,
    setInterval: (callback, delay) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    activeIntervals: () => intervals.size,
    advance: (ms) => {
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(TICK_MS, remaining);
        now += step;
        remaining -= step;
        for (const { callback } of [...intervals.values()]) callback();
      }
    },
  };
};

const LOUD_CHUNK = (() => {
  const buffer = Buffer.alloc(1600);
  for (let i = 0; i < 800; i += 1) buffer.writeInt16LE(3000, i * 2);
  return buffer;
})();

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
  constructor() {
    super();
    this.running = false;
    this.detected = [];
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  getDetectedProcesses() {
    return this.detected.map((processKey) => ({ processKey, appName: processKey }));
  }

  endProcess(processKey) {
    this.detected = this.detected.filter((key) => key !== processKey);
    this.emit("meeting-process-ended", { processKey, appName: processKey });
  }
}

function createEngine(windowManagerOverrides = {}) {
  const clock = createClock();
  const audioActivityDetector = new FakeAudioActivityDetector();
  const meetingProcessDetector = new FakeMeetingProcessDetector();
  const autoEndNotifications = [];
  const dismissedAutoEndNotifications = [];
  const shownNotifications = [];
  const overlayWebContents = { kind: "meeting-notification" };
  const windowManager = {
    notificationPrefs: {},
    showMeetingAutoEndNotification: async (notification) => {
      autoEndNotifications.push(notification);
      return true;
    },
    dismissMeetingAutoEndNotification: (sessionId) =>
      dismissedAutoEndNotifications.push(sessionId),
    isMeetingNotificationSender: (sender) => sender === overlayWebContents,
    showMeetingNotification: (notification) => shownNotifications.push(notification),
    ...windowManagerOverrides,
  };
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => ({ activeMeeting: null, upcomingEvents: [] }) },
    meetingProcessDetector,
    audioActivityDetector,
    windowManager,
    {},
    {
      now: clock.now,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    }
  );

  const micState = (reliable, externalMicActive) =>
    audioActivityDetector.emit("external-mic-state-changed", { reliable, externalMicActive });

  const owner = (messages = []) => ({
    isDestroyed: () => false,
    send: (channel, payload) => messages.push({ channel, payload }),
  });

  return {
    audioActivityDetector,
    autoEndNotifications,
    clock,
    dismissedAutoEndNotifications,
    engine,
    meetingProcessDetector,
    micState,
    overlayWebContents,
    owner,
    shownNotifications,
  };
}

async function triggerOwnershipStop(engineHarness, ownerWebContents) {
  await engineHarness.engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents,
    systemAudioAvailable: true,
  });
  engineHarness.clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  engineHarness.micState(true, false);
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
  const { audioActivityDetector, engine, owner } = createEngine();

  engine.setPreferences({ audioDetection: false });
  assert.equal(audioActivityDetector.running, false);

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  assert.equal(audioActivityDetector.running, true);

  engine.setPreferences({ audioDetection: false });
  assert.equal(audioActivityDetector.running, true);

  assert.equal(engine.endRecordingSession("meeting-1"), true);
  assert.equal(audioActivityDetector.running, false);
});

test("keeps the process detector running for eligible auto-end sessions", async () => {
  const { engine, meetingProcessDetector, owner } = createEngine();

  engine.setPreferences({ processDetection: false });
  assert.equal(meetingProcessDetector.running, false);

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  assert.equal(meetingProcessDetector.running, true);

  engine.endRecordingSession("meeting-1");
  assert.equal(meetingProcessDetector.running, false);
});

test("does not arm auto-end until system audio capture is confirmed", async () => {
  const harness = createEngine();
  const messages = [];
  const ownerWebContents = harness.owner(messages);

  await harness.engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents,
  });
  harness.clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  harness.micState(true, false);
  assert.deepEqual(messages, []);

  assert.equal(
    await harness.engine.setRecordingSystemAudioAvailable("meeting-1", true, ownerWebContents),
    true
  );
  harness.clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  harness.micState(true, false);

  assert.deepEqual(messages, [
    {
      channel: "meeting-auto-end-requested",
      payload: { sessionId: "meeting-1", reason: "mic-released" },
    },
  ]);
  harness.engine.stop();
});

test("reliable mic release requests an immediate stop without showing the recovery notice", async () => {
  const harness = createEngine();
  const messages = [];

  await triggerOwnershipStop(harness, harness.owner(messages));

  assert.deepEqual(messages, [
    {
      channel: "meeting-auto-end-requested",
      payload: { sessionId: "meeting-1", reason: "mic-released" },
    },
  ]);
  assert.deepEqual(harness.autoEndNotifications, []);
  harness.engine.stop();
});

test("system activity from meeting chunks defers ownership stop until quiet", async () => {
  const harness = createEngine();
  const messages = [];

  await harness.engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: harness.owner(messages),
    systemAudioAvailable: true,
  });
  harness.clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  harness.engine.recordMeetingAudioChunk("system", LOUD_CHUNK);
  harness.clock.advance(TICK_MS);

  harness.micState(true, false);
  harness.clock.advance(TICK_MS);
  assert.deepEqual(messages, []);

  harness.clock.advance(5 * TICK_MS);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.reason, "mic-released");
  harness.engine.stop();
});

test("fallback silence immediately requests a scoped stop with its reason", async () => {
  const harness = createEngine();
  const messages = [];
  harness.audioActivityDetector.externalMicState = {
    reliable: true,
    externalMicActive: false,
  };

  await harness.engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: harness.owner(messages),
    systemAudioAvailable: true,
  });
  harness.clock.advance(SILENCE_WINDOW_MS);

  assert.deepEqual(messages, [
    {
      channel: "meeting-auto-end-requested",
      payload: { sessionId: "meeting-1", reason: "silence" },
    },
  ]);
  harness.engine.stop();
});

test("only the last tracked meeting process exiting arms the fast stop", async () => {
  const harness = createEngine();
  const messages = [];
  harness.audioActivityDetector.externalMicState = {
    reliable: false,
    externalMicActive: false,
  };
  harness.meetingProcessDetector.detected = ["zoom", "teams"];

  await harness.engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: harness.owner(messages),
    systemAudioAvailable: true,
  });
  harness.meetingProcessDetector.endProcess("teams");
  harness.clock.advance(FAST_SILENCE_MS + TICK_MS);
  assert.deepEqual(messages, []);

  harness.meetingProcessDetector.endProcess("zoom");
  harness.clock.advance(FAST_SILENCE_MS);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.reason, "process-exit");
  harness.engine.stop();
});

test("the recovery notice appears only after the owning renderer confirms stop completion", async () => {
  const harness = createEngine();
  const messages = [];
  const ownerWebContents = harness.owner(messages);
  await triggerOwnershipStop(harness, ownerWebContents);

  assert.deepEqual(harness.autoEndNotifications, []);
  harness.engine.endRecordingSession("meeting-1");

  assert.equal(
    await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents),
    true
  );
  assert.deepEqual(harness.autoEndNotifications, [
    {
      sessionId: "meeting-1",
      reason: "mic-released",
      expiresAt: harness.clock.now() + RESTART_WINDOW_MS,
    },
  ]);
  harness.engine.stop();
});

test("stop completion rejects a stale session, wrong owner, or still-live recording", async () => {
  const harness = createEngine();
  const ownerWebContents = harness.owner();
  await triggerOwnershipStop(harness, ownerWebContents);

  assert.equal(await harness.engine.completeAutoEndSession("other", ownerWebContents), false);
  assert.equal(await harness.engine.completeAutoEndSession("meeting-1", harness.owner()), false);
  assert.equal(await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents), false);

  harness.engine.endRecordingSession("meeting-1");
  assert.equal(await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents), true);
  harness.engine.stop();
});

test("restart response is owner-scoped, single-use, and dismisses the notice", async () => {
  const harness = createEngine();
  const messages = [];
  const ownerWebContents = harness.owner(messages);
  await triggerOwnershipStop(harness, ownerWebContents);
  harness.engine.endRecordingSession("meeting-1");
  await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents);

  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "restart",
      harness.overlayWebContents
    ),
    true
  );
  assert.deepEqual(messages.at(-1), {
    channel: "meeting-auto-end-restart-requested",
    payload: { sessionId: "meeting-1" },
  });
  assert.deepEqual(harness.dismissedAutoEndNotifications, ["meeting-1"]);
  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "restart",
      harness.overlayWebContents
    ),
    false
  );
  harness.engine.stop();
});

test("dismiss response clears the recovery offer without restarting", async () => {
  const harness = createEngine();
  const messages = [];
  const ownerWebContents = harness.owner(messages);
  await triggerOwnershipStop(harness, ownerWebContents);
  harness.engine.endRecordingSession("meeting-1");
  await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents);

  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "dismiss",
      harness.overlayWebContents
    ),
    true
  );
  assert.equal(
    messages.some(({ channel }) => channel === "meeting-auto-end-restart-requested"),
    false
  );
  assert.deepEqual(harness.dismissedAutoEndNotifications, ["meeting-1"]);
  harness.engine.stop();
});

test("expired, wrong-sender, and invalid auto-end responses are rejected", async () => {
  const harness = createEngine();
  const messages = [];
  const ownerWebContents = harness.owner(messages);
  await triggerOwnershipStop(harness, ownerWebContents);
  harness.engine.endRecordingSession("meeting-1");
  await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents);

  assert.equal(
    harness.engine.respondToAutoEndNotification("meeting-1", "restart", {}),
    false
  );
  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "unknown",
      harness.overlayWebContents
    ),
    false
  );
  harness.clock.advance(RESTART_WINDOW_MS);
  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "restart",
      harness.overlayWebContents
    ),
    false
  );
  assert.equal(
    messages.some(({ channel }) => channel === "meeting-auto-end-restart-requested"),
    false
  );
  assert.deepEqual(harness.dismissedAutoEndNotifications, ["meeting-1"]);
  harness.engine.stop();
});

test("starting another recording invalidates an offered restart", async () => {
  const harness = createEngine();
  const firstOwner = harness.owner();
  await triggerOwnershipStop(harness, firstOwner);
  harness.engine.endRecordingSession("meeting-1");
  await harness.engine.completeAutoEndSession("meeting-1", firstOwner);

  await harness.engine.beginRecordingSession({
    sessionId: "meeting-2",
    autoEndEligible: true,
    ownerWebContents: harness.owner(),
    systemAudioAvailable: true,
  });

  assert.deepEqual(harness.dismissedAutoEndNotifications, ["meeting-1"]);
  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "restart",
      harness.overlayWebContents
    ),
    false
  );
  harness.engine.stop();
});

test("notification load failure invalidates the completed restart offer", async () => {
  const harness = createEngine({
    showMeetingAutoEndNotification: async () => {
      throw new Error("notification load failed");
    },
  });
  const ownerWebContents = harness.owner();
  await triggerOwnershipStop(harness, ownerWebContents);
  harness.engine.endRecordingSession("meeting-1");

  assert.equal(
    await harness.engine.completeAutoEndSession("meeting-1", ownerWebContents),
    false
  );
  assert.equal(
    harness.engine.respondToAutoEndNotification(
      "meeting-1",
      "restart",
      harness.overlayWebContents
    ),
    false
  );
  harness.engine.stop();
});

test("a legacy autoEnd preference cannot disable eligible meeting auto-end", async () => {
  const harness = createEngine();
  const messages = [];
  harness.engine.setPreferences({ audioDetection: false, processDetection: false, autoEnd: false });
  assert.deepEqual(harness.engine.getPreferences(), {
    processDetection: false,
    audioDetection: false,
  });

  await triggerOwnershipStop(harness, harness.owner(messages));

  assert.equal(harness.audioActivityDetector.running, true);
  assert.equal(harness.clock.activeIntervals(), 1);
  assert.equal(messages.length, 1);
  harness.engine.setPreferences({ autoEnd: false });
  assert.equal(harness.clock.activeIntervals(), 1);
  harness.engine.stop();
});

test("the auto-end ticker is cleared on session end and engine stop", async () => {
  const { clock, engine, owner } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  assert.equal(clock.activeIntervals(), 1);
  engine.endRecordingSession("meeting-1");
  assert.equal(clock.activeIntervals(), 0);

  await engine.beginRecordingSession({
    sessionId: "meeting-2",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  assert.equal(clock.activeIntervals(), 1);
  engine.stop();
  assert.equal(clock.activeIntervals(), 0);
});

test("ending with no tracked session allows teardown to proceed", async () => {
  const { engine, owner } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  engine.stop();

  assert.equal(engine.endRecordingSession("meeting-1"), true);
});

const POST_RECORDING_COOLDOWN_MS = 2500;

const nextMeetingReminder = (clock) => ({
  id: "next",
  summary: "Next meeting",
  start_time: new Date(clock.now() + 60_000).toISOString(),
});

test("a detection during a live recording remains queued after the shared recording flag clears", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { clock, engine, owner, shownNotifications } = createEngine();
  engine.setUserRecording(true);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });

  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  engine.handleCalendarReminder(nextMeetingReminder(clock));
  assert.equal(shownNotifications.length, 0);

  engine.endRecordingSession("meeting-1");
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  assert.equal(shownNotifications.length, 1);
  engine.stop();
});

test("a post-dictation queue flush holds detections while the meeting session is live", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { clock, engine, owner, shownNotifications } = createEngine();
  engine.setUserRecording(true);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });

  engine.handleCalendarReminder(nextMeetingReminder(clock));
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  assert.equal(shownNotifications.length, 0);

  engine.endRecordingSession("meeting-1");
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  assert.equal(shownNotifications.length, 1);
  engine.stop();
});

test("a detection-started recording re-enables prompts once its session ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audioActivityDetector, clock, engine, owner, shownNotifications } = createEngine();
  engine.setMeetingModeActive(true);
  engine.setUserRecording(true);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });

  engine.endRecordingSession("meeting-1");
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  audioActivityDetector.emit("sustained-audio-detected", {
    durationMs: 2000,
    detectedAt: clock.now(),
  });

  assert.equal(shownNotifications.length, 1);
  assert.equal(shownNotifications[0].detectionId, "audio:sustained-audio");
  engine.stop();
});

test("the next reminder prompts after a detection-started recording ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { clock, engine, owner, shownNotifications } = createEngine();
  engine.setMeetingModeActive(true);
  engine.setUserRecording(true);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });

  engine.endRecordingSession("meeting-1");
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  engine.handleCalendarReminder(nextMeetingReminder(clock));

  assert.equal(shownNotifications.length, 1);
  assert.equal(shownNotifications[0].detectionId, "calendar:next");
  engine.stop();
});

test("meeting mode still suppresses prompts while a detection-started recording is live", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { audioActivityDetector, clock, engine, owner, shownNotifications } = createEngine();
  engine.setMeetingModeActive(true);
  engine.setUserRecording(true);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });

  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  audioActivityDetector.emit("sustained-audio-detected", {
    durationMs: 2000,
    detectedAt: clock.now(),
  });

  assert.equal(shownNotifications.length, 0);
  engine.stop();
});
