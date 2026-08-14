const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const controllerPath = require.resolve("../../src/helpers/meetingAutoStopController");
const originalLoad = Module._load;

function loadController() {
  delete require.cache[controllerPath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./debugLogger") {
      return { info() {}, warn() {}, debug() {}, error() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(controllerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createController({ detected = [] } = {}) {
  const MeetingAutoStopController = loadController();

  const processDetector = new EventEmitter();
  processDetector.detected = detected;
  processDetector.getDetectedProcesses = () => processDetector.detected;

  const shown = [];
  const sent = [];
  const windowManager = {
    dismissals: 0,
    _pendingNotificationData: null,
    showMeetingNotification(data) {
      this._pendingNotificationData = data;
      shown.push(data);
    },
    dismissMeetingNotification() {
      this.dismissals += 1;
      this._pendingNotificationData = null;
    },
    controlPanelWindow: null,
  };

  const recordingWin = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: {
      send: (channel, data) => sent.push({ channel, data }),
    },
  };

  const controller = new MeetingAutoStopController({ windowManager, processDetector });
  return { controller, processDetector, windowManager, recordingWin, shown, sent };
}

test("process exit for a session app with no other meeting app arms fast mode", (t) => {
  const { controller, processDetector, recordingWin } = createController({
    detected: [{ processKey: "zoom", appName: "Zoom", detectedAt: 1 }],
  });
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);
  processDetector.detected = [];
  processDetector.emit("meeting-process-ended", { processKey: "zoom", appName: "Zoom" });

  assert.notEqual(controller.monitor.fastArmAt, null);
});

test("process exit does not arm when another meeting app is still running", (t) => {
  const { controller, processDetector, recordingWin } = createController({
    detected: [
      { processKey: "zoom", appName: "Zoom", detectedAt: 1 },
      { processKey: "teams", appName: "Microsoft Teams", detectedAt: 2 },
    ],
  });
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);
  processDetector.detected = [{ processKey: "teams", appName: "Microsoft Teams", detectedAt: 2 }];
  processDetector.emit("meeting-process-ended", { processKey: "zoom", appName: "Zoom" });

  assert.equal(controller.monitor.fastArmAt, null);
});

test("process exit outside the session set, or with no recording, never arms", (t) => {
  const { controller, processDetector, recordingWin } = createController();
  t.after(() => controller.onRecordingStopped());

  // Not recording.
  processDetector.emit("meeting-process-ended", { processKey: "zoom", appName: "Zoom" });
  assert.equal(controller.monitor.fastArmAt, null);

  // Recording, but the app was never part of this session (empty snapshot —
  // the manual/calendar-meeting case).
  controller.onRecordingStarted(recordingWin);
  processDetector.emit("meeting-process-ended", { processKey: "zoom", appName: "Zoom" });
  assert.equal(controller.monitor.fastArmAt, null);
});

test("apps launched mid-recording join the session set", (t) => {
  const { controller, processDetector, recordingWin } = createController();
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);
  processDetector.emit("meeting-process-detected", {
    processKey: "webex",
    appName: "Webex",
    detectedAt: 5,
  });
  processDetector.emit("meeting-process-ended", { processKey: "webex", appName: "Webex" });

  assert.notEqual(controller.monitor.fastArmAt, null);
});

test("threshold event shows the ending prompt with the reason's countdown", (t) => {
  const { controller, recordingWin, shown } = createController();
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);
  controller.monitor.onEvent("silence-threshold-reached", { reason: "silence" });

  assert.equal(shown.length, 1);
  assert.equal(shown[0].source, "auto-stop");
  assert.equal(shown[0].variant, "ending");
  assert.equal(shown[0].detectionId, "auto-stop:silence");
  assert.equal(shown[0].timeoutMs, 30_000);
  assert.equal(shown[0].appName, null);

  controller.handleResponse("auto-stop:silence", "keep");
  controller.monitor.onEvent("silence-threshold-reached", { reason: "process-exit" });
  assert.equal(shown.length, 2);
  assert.equal(shown[1].timeoutMs, 15_000);
});

test("activity-resumed dismisses only the auto-stop prompt", (t) => {
  const { controller, windowManager, recordingWin } = createController();
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);

  // Someone else's prompt is pending — leave it alone.
  windowManager._pendingNotificationData = { source: "calendar" };
  controller.monitor.onEvent("activity-resumed", { reason: "audio" });
  assert.equal(windowManager.dismissals, 0);

  windowManager._pendingNotificationData = { source: "auto-stop" };
  controller.monitor.onEvent("activity-resumed", { reason: "audio" });
  assert.equal(windowManager.dismissals, 1);
});

test("keep arms the monitor cooldown and dismisses; stop sends the auto-stop IPC", (t) => {
  const { controller, windowManager, recordingWin, sent } = createController();
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);
  controller.monitor.onEvent("silence-threshold-reached", { reason: "silence" });

  controller.handleResponse("auto-stop:silence", "keep");
  assert.equal(windowManager.dismissals, 1);
  assert.equal(controller.monitor.episodeConsumed, true);
  assert.ok(controller.monitor.cooldownUntil > Date.now());
  assert.equal(sent.length, 0);

  controller.monitor.onEvent("silence-threshold-reached", { reason: "silence" });
  controller.handleResponse("auto-stop:silence", "stop");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "meeting-auto-stop");
  assert.equal(sent[0].data.reason, "silence");
});

test("countdown expiry sends the stop once, with control-panel fallback", (t) => {
  const { controller, windowManager, recordingWin, sent } = createController();
  t.after(() => controller.onRecordingStopped());

  controller.onRecordingStarted(recordingWin);
  controller.monitor.onEvent("silence-threshold-reached", { reason: "process-exit" });
  controller.handleCountdownExpired();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.reason, "process-exit");

  // Late events after dispatch are ignored until the stop round-trip lands.
  controller.handleCountdownExpired();
  controller.monitor.onEvent("silence-threshold-reached", { reason: "silence" });
  assert.equal(sent.length, 1);

  // Destroyed recording window falls back to the control panel.
  controller.onRecordingStopped();
  controller.onRecordingStarted(recordingWin);
  recordingWin.destroyed = true;
  const fallbackSent = [];
  windowManager.controlPanelWindow = {
    isDestroyed: () => false,
    webContents: { send: (channel, data) => fallbackSent.push({ channel, data }) },
  };
  controller.monitor.onEvent("silence-threshold-reached", { reason: "silence" });
  controller.handleCountdownExpired();
  assert.equal(fallbackSent.length, 1);
  assert.equal(fallbackSent[0].channel, "meeting-auto-stop");
});

test("disabled controller neither monitors nor prompts", (t) => {
  const { controller, processDetector, recordingWin, shown, sent } = createController({
    detected: [{ processKey: "zoom", appName: "Zoom", detectedAt: 1 }],
  });
  t.after(() => controller.onRecordingStopped());

  controller.setEnabled(false);
  controller.onRecordingStarted(recordingWin);

  assert.equal(controller.monitor.running, false);
  processDetector.detected = [];
  processDetector.emit("meeting-process-ended", { processKey: "zoom", appName: "Zoom" });
  assert.equal(controller.monitor.fastArmAt, null);
  assert.equal(shown.length, 0);
  assert.equal(sent.length, 0);

  // Re-enabling mid-recording resumes monitoring.
  controller.setEnabled(true);
  assert.equal(controller.monitor.running, true);
});
