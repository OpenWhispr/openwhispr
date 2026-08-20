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

const { COUNTDOWN_MS, SILENCE_WINDOW_MS, FAST_SILENCE_MS, OWNERSHIP_MIN_ACTIVE_MS } =
  createMeetingAutoEndController;

const TICK_MS = 1000;

// Fake clock with a single interval slot: the engine's 1s auto-end ticker.
// advance() steps the clock a second at a time and fires the interval so long
// spans never look like a sleep gap.
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

// A buffer whose RMS is unmistakably above the activity thresholds.
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

  // Mirrors the real detector: the ended key is removed before the event fires.
  endProcess(processKey) {
    this.detected = this.detected.filter((key) => key !== processKey);
    this.emit("meeting-process-ended", { processKey, appName: processKey });
  }
}

function createEngine(windowManagerOverrides = {}) {
  const clock = createClock();
  const audioActivityDetector = new FakeAudioActivityDetector();
  const meetingProcessDetector = new FakeMeetingProcessDetector();
  const shownCountdowns = [];
  const dismissedCountdowns = [];
  const shownNotifications = [];
  const windowManager = {
    notificationPrefs: {},
    showMeetingAutoEndCountdown: (countdown) => shownCountdowns.push(countdown),
    dismissMeetingAutoEndCountdown: (sessionId) => dismissedCountdowns.push(sessionId),
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
    meetingProcessDetector,
    clock,
    dismissedCountdowns,
    engine,
    shownCountdowns,
    shownNotifications,
    micState,
    owner,
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

test("keeps the process detector running for an eligible session while processDetection is off", async () => {
  const { meetingProcessDetector, engine, owner } = createEngine();

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
  const { clock, engine, micState, owner, shownCountdowns } = createEngine();
  const ownerWebContents = owner();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  clock.advance(2 * COUNTDOWN_MS);

  assert.deepEqual(shownCountdowns, []);

  assert.equal(
    await engine.setRecordingSystemAudioAvailable("meeting-1", true, owner()),
    false,
    "a stale renderer must not arm another renderer's recording"
  );
  assert.equal(
    await engine.setRecordingSystemAudioAvailable("meeting-1", true, ownerWebContents),
    true
  );
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);

  assert.equal(shownCountdowns.length, 1);
  engine.stop();
});

test("shows and dismisses the countdown from reliable external mic changes", async () => {
  const { clock, dismissedCountdowns, engine, micState, owner, shownCountdowns } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  micState(true, true);

  assert.deepEqual(shownCountdowns, [
    { sessionId: "meeting-1", expiresAt: clock.now() + COUNTDOWN_MS, reason: "mic-released" },
  ]);
  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  engine.stop();
});

test("system activity from meeting chunks defers the ownership countdown until quiet", async () => {
  const { clock, engine, micState, owner, shownCountdowns } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  engine.recordMeetingAudioChunk("system", LOUD_CHUNK);
  clock.advance(TICK_MS);

  micState(true, false);
  clock.advance(TICK_MS);
  assert.deepEqual(shownCountdowns, [], "remote audio still playing");

  // The system channel ages out once no more loud chunks arrive.
  clock.advance(5 * TICK_MS);
  assert.equal(shownCountdowns.length, 1);
  assert.equal(shownCountdowns[0].reason, "mic-released");
  engine.stop();
});

test("meeting audio chunks are ignored before the controller session begins and after it ends", async () => {
  const { clock, engine, micState, owner, shownCountdowns } = createEngine();

  // Streaming starts before beginRecordingSession is reached in main.
  engine.recordMeetingAudioChunk("system", LOUD_CHUNK);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  assert.equal(
    shownCountdowns.length,
    1,
    "the pre-session chunk must not read as live system audio"
  );

  engine.endRecordingSession("meeting-1");
  assert.doesNotThrow(() => engine.recordMeetingAudioChunk("mic", LOUD_CHUNK));
  clock.advance(2 * SILENCE_WINDOW_MS);
  assert.equal(shownCountdowns.length, 1);
});

test("fallback silence prompts and forwards the reason to the countdown and stop request", async () => {
  const { audioActivityDetector, clock, engine, owner, shownCountdowns } = createEngine();
  const messages = [];
  audioActivityDetector.externalMicState = { reliable: true, externalMicActive: false };

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(messages),
    systemAudioAvailable: true,
  });
  clock.advance(SILENCE_WINDOW_MS);

  assert.equal(shownCountdowns.length, 1);
  assert.equal(shownCountdowns[0].reason, "silence");
  clock.advance(COUNTDOWN_MS);
  assert.deepEqual(messages, [
    {
      channel: "meeting-auto-end-requested",
      payload: { sessionId: "meeting-1", reason: "silence" },
    },
  ]);
  engine.stop();
});

test("meeting-process-ended tightens the silence window only when no tracked app remains", async () => {
  const { audioActivityDetector, clock, engine, meetingProcessDetector, owner, shownCountdowns } =
    createEngine();
  audioActivityDetector.externalMicState = { reliable: false, externalMicActive: false };
  meetingProcessDetector.detected = ["zoom", "teams"];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  meetingProcessDetector.endProcess("teams");
  clock.advance(FAST_SILENCE_MS + TICK_MS);
  assert.deepEqual(shownCountdowns, [], "Zoom is still running");

  meetingProcessDetector.endProcess("zoom");
  clock.advance(FAST_SILENCE_MS);
  assert.equal(shownCountdowns.length, 1);
  assert.equal(shownCountdowns[0].reason, "process-exit");
  engine.stop();
});

test("reliability loss dismisses the countdown and prevents auto-stop", async () => {
  const { clock, dismissedCountdowns, engine, micState, owner } = createEngine();
  const messages = [];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(messages),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  clock.advance(30_000);

  micState(false, false);
  clock.advance(COUNTDOWN_MS);

  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  assert.deepEqual(messages, []);
  engine.stop();
});

test("countdown presentation failure keeps the recording active", async () => {
  const { clock, engine, micState, owner } = createEngine({
    showMeetingAutoEndCountdown: () => Promise.reject(new Error("notification load failed")),
  });
  const messages = [];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(messages),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  await Promise.resolve();
  await Promise.resolve();
  clock.advance(2 * COUNTDOWN_MS);

  assert.deepEqual(messages, []);
  engine.stop();
});

test("expiry requests one stop from the renderer that owns the current session", async () => {
  const { clock, dismissedCountdowns, engine, micState, owner } = createEngine();
  const messages = [];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(messages),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  clock.advance(3 * COUNTDOWN_MS);

  assert.deepEqual(messages, [
    {
      channel: "meeting-auto-end-requested",
      payload: { sessionId: "meeting-1", reason: "mic-released" },
    },
  ]);
  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  engine.stop();
});

test("replacement cancels the old countdown and stale end requests preserve the new session", async () => {
  const { clock, dismissedCountdowns, engine, micState } = createEngine();
  const messages = [];

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => messages.push("meeting-1") },
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);

  await engine.beginRecordingSession({
    sessionId: "meeting-2",
    autoEndEligible: true,
    ownerWebContents: { isDestroyed: () => false, send: () => messages.push("meeting-2") },
    systemAudioAvailable: true,
  });
  assert.equal(engine.endRecordingSession("meeting-1"), false);
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  clock.advance(2 * COUNTDOWN_MS);

  assert.deepEqual(dismissedCountdowns, ["meeting-1", "meeting-2"]);
  assert.deepEqual(messages, ["meeting-2"]);
  engine.stop();
});

test("an ineligible recording does not retain the audio detector", async () => {
  const { audioActivityDetector, clock, engine, micState, owner, shownCountdowns } = createEngine();

  engine.setPreferences({ audioDetection: false });
  await engine.beginRecordingSession({
    sessionId: "personal-1",
    autoEndEligible: false,
    ownerWebContents: owner(),
  });
  micState(true, false);
  clock.advance(2 * SILENCE_WINDOW_MS);

  assert.equal(audioActivityDetector.running, false);
  assert.deepEqual(shownCountdowns, []);
  assert.equal(engine.endRecordingSession("personal-1"), true);
});

test("keep recording suppresses prompts until fresh ownership evidence, only for the matching session", async () => {
  const { clock, dismissedCountdowns, engine, micState, owner, shownCountdowns } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);

  assert.equal(engine.keepRecordingSession("stale-session"), false);
  assert.equal(engine.keepRecordingSession("meeting-1"), true);
  assert.deepEqual(dismissedCountdowns, ["meeting-1"]);
  clock.advance(2 * COUNTDOWN_MS);
  assert.equal(shownCountdowns.length, 1, "no re-prompt without fresh evidence");

  micState(true, true);
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  assert.equal(shownCountdowns.length, 2, "a rejoined-and-left call re-prompts at once");
  assert.equal(shownCountdowns[1].reason, "mic-released");
  engine.stop();
});

test("keep recording after countdown expiry reports a stale session", async () => {
  const { clock, engine, micState, owner } = createEngine();

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  clock.advance(COUNTDOWN_MS);

  assert.equal(engine.keepRecordingSession("meeting-1"), false);
  engine.stop();
});

test("a legacy autoEnd preference cannot disable eligible meeting auto-end", async () => {
  const { audioActivityDetector, clock, engine, micState, owner, shownCountdowns } = createEngine();
  engine.setPreferences({ audioDetection: false, processDetection: false, autoEnd: false });
  assert.deepEqual(engine.getPreferences(), {
    processDetection: false,
    audioDetection: false,
  });

  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });
  assert.equal(audioActivityDetector.running, true);
  assert.equal(clock.activeIntervals(), 1);

  clock.advance(OWNERSHIP_MIN_ACTIVE_MS);
  micState(true, false);
  assert.equal(shownCountdowns.length, 1);

  engine.setPreferences({ autoEnd: false });
  assert.equal(clock.activeIntervals(), 1);
  engine.stop();
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
  // Quit-path engine stop clears the session while capture may still be live;
  // a scoped stop afterwards must not be treated as stale or streams leak.
  engine.stop();

  assert.equal(engine.endRecordingSession("meeting-1"), true);
});

// The user-recording flag is shared with dictation, so a dictation ending
// mid-meeting clears it while the recording is still live. Without the engine's
// own session as a gate, the next detection would bypass the queue and its
// prompt would replace a visible auto-end countdown card — the countdown then
// runs on invisibly and stops the recording without a chance to keep it.
const POST_RECORDING_COOLDOWN_MS = 2500;

const nextMeetingReminder = (clock) => ({
  id: "next",
  summary: "Next meeting",
  start_time: new Date(clock.now() + 60_000).toISOString(),
});

test("a detection during a live recording session is queued even after the user-recording flag is cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { clock, engine, owner, shownNotifications } = createEngine();
  engine.setUserRecording(true);
  await engine.beginRecordingSession({
    sessionId: "meeting-1",
    autoEndEligible: true,
    ownerWebContents: owner(),
    systemAudioAvailable: true,
  });

  // A dictation ended mid-meeting: the shared flag clears and its cooldown runs out.
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);

  engine.handleCalendarReminder(nextMeetingReminder(clock));
  assert.equal(shownNotifications.length, 0, "no prompt may surface while the recording is live");

  // The recording ends the way ipcHandlers ends it; the held prompt surfaces then.
  engine.endRecordingSession("meeting-1");
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  assert.equal(shownNotifications.length, 1);
  assert.equal(shownNotifications[0].detectionId, "calendar:next");
  engine.stop();
});

test("a post-dictation queue flush holds queued detections while the recording session is live", async (t) => {
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
  assert.equal(shownNotifications.length, 0, "queued behind the user-recording gate");

  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  assert.equal(shownNotifications.length, 0, "the flush must not surface it mid-recording");

  engine.endRecordingSession("meeting-1");
  engine.setUserRecording(false);
  t.mock.timers.tick(POST_RECORDING_COOLDOWN_MS);
  assert.equal(shownNotifications.length, 1);
  engine.stop();
});

// "Take notes" / the meeting hotkey / calendar Join set meeting mode when they
// create the note, and until now only the narrow layout's "Back to notes"
// button ever cleared it. In the wide layout that left every later mic,
// process, and calendar detection suppressed for the rest of the app session.
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
  assert.equal(shownNotifications.length, 1, "the next call must prompt again");
  assert.equal(shownNotifications[0].detectionId, "audio:sustained-audio");
  engine.stop();
});

test("the next meeting's reminder prompts after a detection-started recording ends", async (t) => {
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
  assert.equal(shownNotifications.length, 1, "no longer suppressed as meeting-mode noise");
  assert.equal(shownNotifications[0].detectionId, "calendar:next");
  engine.stop();
});

test("meeting mode still suppresses prompts while the detection-started recording is live", async (t) => {
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
