const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("node:events");

const health = require("../../src/helpers/meetingDetectionHealth");
const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");
const AudioActivityDetector = require("../../src/helpers/audioActivityDetector");
const CallStateDetector = require("../../src/helpers/callStateDetector");

// Every path that drops a detection has to say so. Without this the stack can be
// fully broken and still look idle.

function createEngine({ notificationPrefs = {}, preferences = {} } = {}) {
  const noop = () => {};
  const shown = [];
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => null },
    { on: noop, start: noop, stop: noop },
    { on: noop, start: noop, stop: noop, resetPrompt: noop, dismiss: noop, setUserRecording: noop },
    {
      notificationPrefs,
      showMeetingNotification: (payload) => shown.push(payload),
      dismissMeetingNotification: noop,
    },
    {},
    null
  );
  Object.assign(engine.preferences, preferences);
  return { engine, shown };
}

test.beforeEach(() => health.reset());

test("a detection dropped by the meeting-mode latch records why", () => {
  const { engine } = createEngine();
  engine._meetingModeActive = true;

  engine._handleDetection("audio", "sustained-audio", {});

  const snapshot = health.getSnapshot();
  assert.equal(snapshot.lastSuppression.reason, "meeting-mode-active");
  assert.equal(snapshot.lastSuppression.detectionId, "audio:sustained-audio");
  assert.equal(snapshot.suppressionCounts["meeting-mode-active"], 1);
});

test("a detection dropped by preference records why", () => {
  const { engine } = createEngine({ notificationPrefs: { notificationsEnabled: false } });

  engine._handleDetection("audio", "sustained-audio", {});

  assert.equal(health.getSnapshot().lastSuppression.reason, "notifications-disabled");
});

test("a duplicate detection id records why", () => {
  const { engine } = createEngine();
  engine.activeDetections.set("audio:sustained-audio", {});

  engine._handleDetection("audio", "sustained-audio", {});

  assert.equal(health.getSnapshot().lastSuppression.reason, "already-active");
});

test("audio detection turned off records why", () => {
  const { engine } = createEngine({ preferences: { audioDetection: false } });

  engine._handleDetection("audio", "sustained-audio", {});

  assert.equal(health.getSnapshot().lastSuppression.reason, "audio-detection-disabled");
});

test("the latch values are published as they change", () => {
  const { engine } = createEngine();

  engine._meetingModeActive = true;
  engine.endMeetingSession();

  assert.deepEqual(health.getSnapshot().latches, {
    meetingModeActive: false,
    userRecording: false,
  });
});

test("a delivered detection is recorded as an event", () => {
  const { engine, shown } = createEngine();

  engine._handleDetection("audio", "sustained-audio", {});

  assert.equal(shown.length, 1);
  const detector = health.getSnapshot().detectors.find((d) => d.name === "engine");
  assert.ok(detector.lastEventAt, "a delivered prompt is the proof detection still works");
});

test("the mic detector records why it suppressed a repeat prompt", () => {
  const detector = new AudioActivityDetector();
  detector.hasPrompted = true;

  detector._onMicStateChanged(true);

  assert.equal(health.getSnapshot().lastSuppression.reason, "already-prompted");
});

test("the mic detector records that our own recording holds the mic", () => {
  const detector = new AudioActivityDetector();
  detector._userRecording = true;

  detector._onMicStateChanged(true);

  assert.equal(health.getSnapshot().lastSuppression.reason, "user-recording");
});

test("a listener that exits records its exit code and the degraded mode", () => {
  const detector = new AudioActivityDetector();
  const child = new EventEmitter();
  child.pid = 4321;
  detector._listenerProcess = child;
  health.recordChild("audio", { pid: child.pid, alive: true });
  detector._attachFallbackHandlers(child, "macos-mic-listener");

  child.emit("exit", 9);

  const audio = health.getSnapshot().detectors.find((d) => d.name === "audio");
  assert.equal(audio.lastExitCode, 9);
  assert.equal(audio.childAlive, false);
  assert.notEqual(audio.mode, "event-driven", "a dead listener is not event-driven");
  assert.ok(audio.reason, "the mode change must name a reason");
});

test("the call detector reports itself unavailable when its binary is missing", () => {
  const detector = new CallStateDetector();
  detector._binaryPath = () => null;

  detector.start();

  const call = health.getSnapshot().detectors.find((d) => d.name === "call");
  assert.equal(call.mode, "unavailable");
  assert.equal(call.reason, "binary-not-found");
  assert.equal(health.getStatus(), "unavailable");
});

test("the mic detector records its dismiss cooldown", () => {
  const detector = new AudioActivityDetector();
  detector.lastDismissedAt = Date.now();

  detector._onMicStateChanged(true);

  assert.equal(health.getSnapshot().lastSuppression.reason, "dismiss-cooldown");
});
