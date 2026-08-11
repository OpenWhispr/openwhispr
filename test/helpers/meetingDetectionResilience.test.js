const test = require("node:test");
const assert = require("node:assert/strict");
const { mock } = require("node:test");

const health = require("../../src/helpers/meetingDetectionHealth");
const MeetingDetectionEngine = require("../../src/helpers/meetingDetectionEngine");

// The meeting-mode latch disables all detection while it is set. Four separate
// paths could leave it set forever: a rejected navigation on each of the three
// session starts, and a renderer that never told us the session was over.

function createEngine({ navigate, calendarEvent } = {}) {
  const noop = () => {};
  const shown = [];
  const engine = new MeetingDetectionEngine(
    { getActiveMeetingState: () => null },
    { on: noop, start: noop, stop: noop },
    { on: noop, start: noop, stop: noop, resetPrompt: noop, dismiss: noop, setUserRecording: noop },
    {
      notificationPrefs: {},
      showMeetingNotification: (payload) => shown.push(payload),
      dismissMeetingNotification: noop,
      queueMeetingNoteNavigation: navigate || (async () => {}),
    },
    {
      saveNote: () => ({ note: { id: 1, title: "New note" } }),
      getMeetingsFolder: () => ({ id: 7 }),
      getActiveEvents: () => [],
      getCalendarEventById: () => calendarEvent ?? null,
      autoMapMeetingType: () => null,
      updateNote: (id, updates) => ({ success: true, note: { id, ...updates } }),
    },
    { setSelfRecording: noop, on: noop, start: noop, stop: noop }
  );
  engine.broadcastToWindows = noop;
  engine.preferences.autoStartRecording = true;
  return { engine, shown };
}

const rejects = async () => {
  throw new Error("renderer went away");
};

test.beforeEach(() => health.reset());

test("a failed auto-start does not leave the latch set", async () => {
  const { engine } = createEngine({ navigate: rejects });

  engine._handleCallActive({ devices: { microphone: true }, urlMatch: { matched: true } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(engine._meetingModeActive, false);
  assert.equal(engine._autoStarted, false);
});

test("a failed manual start does not leave the latch set", async () => {
  const { engine } = createEngine({ navigate: rejects });

  await engine.startManualMeeting();

  assert.equal(engine._meetingModeActive, false);
});

test("a failed calendar join does not leave the latch set", async () => {
  const { engine } = createEngine({
    navigate: rejects,
    calendarEvent: { id: "evt-1", summary: "Standup" },
  });

  await engine.joinCalendarMeeting("evt-1");

  assert.equal(engine._meetingModeActive, false);
});

test("the watchdog clears a latch left set after recording stopped", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const { engine } = createEngine();
  engine._meetingModeActive = true;
  engine.setUserRecording(true);
  engine.setUserRecording(false);

  t.mock.timers.tick(20 * 60 * 1000);

  assert.equal(engine._meetingModeActive, false);
  assert.equal(health.getSnapshot().latches.meetingModeActive, false);
  assert.equal(
    health.getSnapshot().lastSuppression.reason,
    "watchdog-cleared-meeting-mode",
    "a backstop that fires silently teaches us nothing"
  );
});

test("the watchdog leaves an in-progress recording alone", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const { engine } = createEngine();
  engine._meetingModeActive = true;
  engine.setUserRecording(true);

  t.mock.timers.tick(60 * 60 * 1000);

  assert.equal(engine._meetingModeActive, true, "a live recording must never be cut short");
});

test("a stranded detection id is swept so detection can resume", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.after(() => mock.timers.reset());

  const { engine, shown } = createEngine();
  engine._handleDetection("audio", "sustained-audio", {});
  assert.equal(shown.length, 1);

  // The overlay was never answered, so the entry stays behind and every later
  // mic detection collides with it.
  engine._handleDetection("audio", "sustained-audio", {});
  assert.equal(shown.length, 1);

  t.mock.timers.tick(31 * 60 * 1000);
  engine._handleDetection("audio", "sustained-audio", {});

  assert.equal(shown.length, 2, "a stale detection id must not block detection forever");
});

test("flushing the queue clears the detections it abandons", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());

  const { engine } = createEngine();
  engine.setUserRecording(true);
  engine._handleDetection("audio", "sustained-audio", {});
  engine._handleDetection("calendar", "evt-9", { event: null });
  assert.equal(engine.activeDetections.size, 2);

  engine.setUserRecording(false);
  t.mock.timers.tick(3000);

  assert.deepEqual(
    [...engine.activeDetections.keys()],
    ["audio:sustained-audio"],
    "only the prompt that was actually shown may stay active"
  );
});

test("revalidate restarts a detector whose child died", () => {
  const { engine } = createEngine();
  let restarted = 0;
  engine.audioActivityDetector.revalidate = () => {
    restarted += 1;
  };
  engine.callStateDetector.revalidate = () => {
    restarted += 1;
  };

  engine.revalidate("resume");

  assert.equal(restarted, 2);
});
