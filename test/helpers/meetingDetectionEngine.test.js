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
  audioDetector.start = () => {};
  audioDetector.stop = () => {};

  const shown = [];
  const windowManager = {
    notificationPrefs: {},
    showMeetingNotification: (data) => shown.push(data),
    dismissMeetingNotification: () => {},
    queueMeetingNoteNavigation: async () => {},
  };

  const engine = new MeetingDetectionEngine(
    reminderScheduler,
    processDetector,
    audioDetector,
    windowManager,
    {}
  );

  return { engine, audioDetector, shown };
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
