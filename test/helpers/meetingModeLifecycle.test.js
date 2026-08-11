const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { mock } = require("node:test");

const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");

// Ending a meeting recording used to clear only `_userRecording`. `_meetingModeActive`
// stayed latched, and every subsequent detection was dropped at the suppression gate,
// so meeting detection silently died after any meeting where the user never clicked
// "Back to notes" — a button that isn't even rendered in the wide-window layout.

function createEngine() {
  const noop = () => {};
  const shown = [];
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => null },
    { on: noop, start: noop, stop: noop },
    {
      on: noop,
      start: noop,
      stop: noop,
      resetPrompt: noop,
      dismiss: noop,
      setUserRecording: noop,
    },
    {
      notificationPrefs: {},
      showMeetingNotification: (payload) => shown.push(payload),
      dismissMeetingNotification: noop,
    },
    {},
    null
  );
  return { engine, shown };
}

test("ending a meeting recording clears the meeting-mode latch", () => {
  const { engine } = createEngine();
  engine._meetingModeActive = true;
  engine._userRecording = true;

  engine.endMeetingSession();

  assert.equal(engine._meetingModeActive, false);
  assert.equal(engine._userRecording, false);
});

test("detection resumes after a meeting recording ends", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const { engine, shown } = createEngine();
  engine._meetingModeActive = true;
  engine._userRecording = true;

  engine.endMeetingSession();
  engine._handleDetection("audio", "sustained-audio", {});

  // The post-recording cooldown queues it rather than dropping it; the latch would
  // have discarded it outright.
  assert.equal(engine._notificationQueue.length, 1);

  t.mock.timers.tick(3000);

  assert.equal(shown.length, 1, "the queued detection must reach the overlay");
  assert.equal(shown[0].detectionId, "audio:sustained-audio");
});

const STOP_HANDLER_SOURCE = (() => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  const start = source.indexOf('ipcMain.handle("meeting-transcription-stop"');
  const end = source.indexOf('ipcMain.handle("dictation-realtime-warmup"');
  assert.ok(start > -1 && end > start, "could not locate the meeting-transcription-stop handler");
  return source.slice(start, end);
})();

test("meeting-transcription-stop ends the whole meeting session, not just the recording", () => {
  assert.match(STOP_HANDLER_SOURCE, /meetingDetectionEngine\?\.endMeetingSession\(/);
  assert.doesNotMatch(
    STOP_HANDLER_SOURCE,
    /setUserRecording\(false\)/,
    "clearing only the recording flag leaves the meeting-mode latch set"
  );
});
