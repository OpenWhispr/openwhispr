const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const enginePath = require.resolve("../../src/helpers/meetingDetectionEngine");
const originalLoad = Module._load;

function loadEngine() {
  delete require.cache[enginePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { shell: { openExternal: async () => {} } };
    }
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    if (request === "./windowBroadcast") {
      return { broadcastToWindows() {} };
    }
    // ESM module; the app loads it through a transpiling loader.
    if (request === "./meetingJoinUrl") {
      return { getMeetingJoinUrl: (event) => event?.hangout_link ?? null };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(enginePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createEngine() {
  const MeetingDetectionEngine = loadEngine();

  const reminderScheduler = {
    getActiveMeetingState: () => ({ activeMeeting: null, activeEvents: [], upcomingEvents: [] }),
  };
  const processDetector = new EventEmitter();
  processDetector.start = () => {};
  processDetector.stop = () => {};

  const audioDetector = new EventEmitter();
  audioDetector.dismissals = 0;
  audioDetector.dismiss = () => audioDetector.dismissals++;
  audioDetector.resetPrompt = () => {};
  audioDetector.setUserRecording = () => {};
  audioDetector.setMicWarmHold = () => {};
  audioDetector.meetingAppNotifications = 0;
  audioDetector.notifyMeetingAppsChanged = () => audioDetector.meetingAppNotifications++;
  audioDetector.start = () => {};
  audioDetector.stop = () => {};

  const shown = [];
  const meetingNavigations = [];
  const noteNavigations = [];
  const refusals = [];
  const windowManager = {
    notificationPrefs: {},
    showMeetingNotification: (data) => shown.push(data),
    dismissMeetingNotification: () => {},
    queueMeetingNoteNavigation: async (payload) => meetingNavigations.push(payload),
    queueNoteNavigation: async (payload) => noteNavigations.push(payload),
    notifyMeetingAlreadyRecording: () => refusals.push("already-recording"),
  };

  const engine = new MeetingDetectionEngine(
    reminderScheduler,
    processDetector,
    audioDetector,
    windowManager,
    {}
  );

  return {
    engine,
    audioDetector,
    processDetector,
    shown,
    meetingNavigations,
    noteNavigations,
    refusals,
  };
}

test("an unanswered audio prompt expires without cooling down the mic detector", () => {
  const { engine, audioDetector, shown } = createEngine();

  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  assert.equal(shown.length, 1, "the detection must reach the overlay");

  engine.handleNotificationTimeout();

  assert.equal(audioDetector.dismissals, 0, "a timeout is not a decline; no cooldown may start");
  assert.equal(engine.activeDetections.size, 0, "expired detections must be cleared");
});

test("explicitly dismissing an audio prompt still starts the mic cooldown", async () => {
  const { engine, audioDetector, shown } = createEngine();

  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  await engine.handleNotificationResponse(shown[0].detectionId, "dismiss");

  assert.equal(audioDetector.dismissals, 1, "an explicit decline must keep its cooldown");
});

test("a detection card closed without a response allows the next prompt", () => {
  const { engine, audioDetector, shown } = createEngine();

  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  engine.handleDetectionNotificationClosed(shown[0].detectionId);
  audioDetector.emit("sustained-audio-detected", { durationMs: 4000, detectedAt: 1 });

  assert.equal(shown.length, 2);
});

test("a meeting app appearing asks the mic detector to re-evaluate unattributed activity", () => {
  const { audioDetector, processDetector, shown } = createEngine();

  processDetector.emit("meeting-process-detected", {
    processKey: "zoom",
    appName: "Zoom",
    detectedAt: 0,
  });

  assert.equal(audioDetector.meetingAppNotifications, 1);
  assert.equal(shown.length, 0, "a running meeting app alone stays context-only");
});

// The bare {} databaseManager is the assertion that no note was created: reaching
// the note path at all would throw on getActiveEvents.
test("a manual meeting start during a live recording surfaces that note, not a new one", async () => {
  const { engine, noteNavigations } = createEngine();
  engine._recordingSession = { sessionId: "s1", noteId: 42 };

  await engine.startManualMeeting();

  assert.deepEqual(noteNavigations, [{ noteId: 42 }]);
});

// There is no note to surface, so the click gets a message instead of silence.
test("a live recording with no note id still blocks a second manual meeting", async () => {
  const { engine, noteNavigations, refusals } = createEngine();
  engine._recordingSession = { sessionId: "s2", noteId: null };

  await engine.startManualMeeting();

  assert.deepEqual(noteNavigations, []);
  assert.deepEqual(refusals, ["already-recording"]);
});
