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
  processDetector.running = false;
  processDetector.start = () => {
    processDetector.running = true;
  };
  processDetector.stop = () => {
    processDetector.running = false;
  };

  const audioDetector = new EventEmitter();
  audioDetector.dismissals = 0;
  audioDetector.dismiss = () => audioDetector.dismissals++;
  audioDetector.resetPrompt = () => {};
  audioDetector.getExternalMicState = () => ({ reliable: true, externalMicActive: true });
  audioDetector.setUserRecording = () => {};
  audioDetector.setMicWarmHold = () => {};
  audioDetector.meetingAppNotifications = 0;
  audioDetector.notifyMeetingAppsChanged = () => audioDetector.meetingAppNotifications++;
  audioDetector.running = false;
  audioDetector.start = () => {
    audioDetector.running = true;
  };
  audioDetector.stop = () => {
    audioDetector.running = false;
  };

  const shown = [];
  const meetingNavigations = [];
  const noteNavigations = [];
  const windowManager = {
    notificationPrefs: {},
    showMeetingNotification: (data) => shown.push(data),
    dismissMeetingNotification: () => {},
    queueMeetingNoteNavigation: async (payload) => meetingNavigations.push(payload),
    queueNoteNavigation: async (payload) => noteNavigations.push(payload),
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
    windowManager,
    shown,
    meetingNavigations,
    noteNavigations,
  };
}

test("an unanswered audio prompt expires without cooling down the mic detector", () => {
  const { engine, audioDetector, shown } = createEngine();

  engine.setPreferences({ audioDetection: true, processDetection: true });
  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  assert.equal(shown.length, 1, "the detection must reach the overlay");

  engine.handleNotificationTimeout();

  assert.equal(audioDetector.dismissals, 0, "a timeout is not a decline; no cooldown may start");
  assert.equal(engine.activeDetections.size, 0, "expired detections must be cleared");
});

test("explicitly dismissing an audio prompt still starts the mic cooldown", async () => {
  const { engine, audioDetector, shown } = createEngine();

  engine.setPreferences({ audioDetection: true, processDetection: true });
  audioDetector.emit("sustained-audio-detected", { durationMs: 2000, detectedAt: 0 });
  await engine.handleNotificationResponse(shown[0].detectionId, "dismiss");

  assert.equal(audioDetector.dismissals, 1, "an explicit decline must keep its cooldown");
});

test("a detection card closed without a response allows the next prompt", () => {
  const { engine, audioDetector, shown } = createEngine();

  engine.setPreferences({ audioDetection: true, processDetection: true });
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

test("a live recording with no note id still blocks a second manual meeting", async () => {
  const { engine, noteNavigations } = createEngine();
  engine._recordingSession = { sessionId: "s2", noteId: null };

  await engine.startManualMeeting();

  assert.deepEqual(noteNavigations, []);
});

// The IPC adapter derives detector preferences through this policy; the engine
// only has to honour whatever it is handed (adapter coverage lives in
// meetingDetectionPreferencesIpc.test.js).
const { deriveDetectorPreferences } = require("../../src/helpers/meetingDetectionPreferencePolicy");

const ENABLED_SNAPSHOT = {
  notificationsEnabled: true,
  notifyMeetingDetection: true,
  meetingProcessDetection: true,
};

function applySnapshot(engine, snapshot) {
  engine.setPreferences(deriveDetectorPreferences(snapshot));
}

test("startup waits for saved notification preferences before starting prompt detectors", () => {
  const { engine, audioDetector, processDetector } = createEngine();
  engine.start();
  assert.equal(audioDetector.running, false);
  assert.equal(processDetector.running, false);
});

test("a snapshot with meeting prompts disabled never starts prompt detectors", () => {
  const { engine, audioDetector, processDetector } = createEngine();
  engine.start();
  applySnapshot(engine, { ...ENABLED_SNAPSHOT, notifyMeetingDetection: false });
  assert.equal(audioDetector.running, false);
  assert.equal(processDetector.running, false);
});

test("notification toggles gate both detectors and retain the process preference", () => {
  const { engine, audioDetector, processDetector } = createEngine();
  applySnapshot(engine, ENABLED_SNAPSHOT);
  assert.equal(audioDetector.running, true);
  assert.equal(processDetector.running, true);
  applySnapshot(engine, { ...ENABLED_SNAPSHOT, notificationsEnabled: false });
  assert.equal(audioDetector.running, false);
  assert.equal(processDetector.running, false);
  applySnapshot(engine, { ...ENABLED_SNAPSHOT, meetingProcessDetection: false });
  assert.equal(audioDetector.running, true);
  assert.equal(processDetector.running, false);
  applySnapshot(engine, { ...ENABLED_SNAPSHOT, notifyMeetingDetection: false });
  assert.equal(audioDetector.running, false);
  assert.equal(processDetector.running, false);
  applySnapshot(engine, ENABLED_SNAPSHOT);
  assert.equal(audioDetector.running, true);
  assert.equal(processDetector.running, true);
});

test("repeated preference snapshots preserve the detector listener registrations", () => {
  const { engine, audioDetector, processDetector } = createEngine();
  for (let index = 0; index < 3; index += 1) applySnapshot(engine, ENABLED_SNAPSHOT);
  assert.equal(audioDetector.listenerCount("sustained-audio-detected"), 1);
  assert.equal(processDetector.listenerCount("meeting-process-detected"), 1);
});

test("disabling notifications preserves active auto-end and releases both detectors at session end", async (t) => {
  const { engine, audioDetector, processDetector } = createEngine();
  t.after(() => engine.stop());
  applySnapshot(engine, ENABLED_SNAPSHOT);
  await engine.beginRecordingSession({
    sessionId: "active-meeting",
    autoEndEligible: true,
    systemAudioAvailable: true,
  });
  applySnapshot(engine, { ...ENABLED_SNAPSHOT, notificationsEnabled: false });
  assert.equal(audioDetector.running, true);
  assert.equal(processDetector.running, true);
  assert.equal(engine.endRecordingSession("active-meeting"), true);
  assert.equal(audioDetector.running, false);
  assert.equal(processDetector.running, false);
});
