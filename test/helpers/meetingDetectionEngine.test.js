const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const enginePath = require.resolve("../../src/helpers/meetingDetectionEngine");
const originalLoad = Module._load;
const openedUrls = [];

function loadEngine() {
  delete require.cache[enginePath];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return { shell: { openExternal: async (url) => openedUrls.push(url) } };
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
  const owner = { prompt: shown[0], detection: engine.activeDetections.get(shown[0].detectionId) };
  await engine.handleNotificationResponse(shown[0].detectionId, "dismiss", {}, owner);

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

// Join & transcribe resumes only a note the user owns for the event: a
// teammate's synced note for the same invite never comes back from the lookup,
// so the join must create the user's own note rather than record into theirs.
function createJoinDatabase(ownNote) {
  const lookups = [];
  const saved = [];
  const databaseManager = {
    getCalendarEventById: (id) => ({ id, summary: "Weekly sync" }),
    getOwnNoteByCalendarEventId: (id) => {
      lookups.push(id);
      return ownNote;
    },
    getMeetingsFolder: () => ({ id: 7 }),
    saveNote: (title) => {
      saved.push(title);
      return { note: { id: 99, title } };
    },
    updateNote: (id, updates) => ({ note: { id, ...updates } }),
  };
  return { databaseManager, lookups, saved };
}

test("joining a calendar meeting resumes the user's own note for the event", async () => {
  const { engine, meetingNavigations } = createEngine();
  const db = createJoinDatabase({ id: 5, folder_id: 3 });
  engine.databaseManager = db.databaseManager;

  await engine.joinCalendarMeeting("event-1");

  assert.deepEqual(db.lookups, ["event-1"]);
  assert.deepEqual(db.saved, []);
  assert.equal(meetingNavigations.length, 1);
  assert.equal(meetingNavigations[0].noteId, 5);
  assert.equal(meetingNavigations[0].folderId, 3);
});

test("joining a calendar meeting with no note of the user's own creates one", async () => {
  const { engine, meetingNavigations } = createEngine();
  const db = createJoinDatabase(null);
  engine.databaseManager = db.databaseManager;

  await engine.joinCalendarMeeting("event-1");

  assert.deepEqual(db.saved, ["Weekly sync"]);
  assert.equal(meetingNavigations.length, 1);
  assert.equal(meetingNavigations[0].noteId, 99);
  assert.equal(meetingNavigations[0].folderId, 7);
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

function ownedNotification(t) {
  const ctx = createEngine();
  const { createDb } = require("./harness/db");
  const db = createDb(t);
  if (!db) return null;
  ctx.engine.databaseManager = db;
  const detection = {
    source: "calendar",
    key: "event",
    event: { id: "event", calendar_id: "test-calendar", summary: "Weekly" },
  };
  ctx.engine.activeDetections.set("calendar:event", detection);
  const owner = {
    prompt: { detectionId: "calendar:event" },
    detection,
    selectedDestination: null,
  };
  let current = true;
  Object.assign(ctx.windowManager, {
    meetingRecentDestinations: [],
    isMeetingNotificationOwner: (o) => current && o === owner,
    updateMeetingNotificationPause() {},
    dismissMeetingNotification() {
      current = false;
    },
    queueMeetingNoteNavigation: async (payload) => {
      ctx.meetingNavigations.push(payload);
      return { success: true, value: db.getNote(payload.noteId) };
    },
  });
  return {
    ...ctx,
    db,
    owner,
    respond: (options) =>
      ctx.engine.handleNotificationResponse("calendar:event", "start", options, owner),
  };
}

test("notification Start saves directly in selected folder and duplicate clicks share navigation", async (t) => {
  const c = ownedNotification(t);
  if (!c) return;
  const folder = c.db.createFolder("Chosen").folder;
  c.owner.selectedDestination = { folderId: folder.id, spaceId: folder.space_id };
  let finish;
  c.windowManager.queueMeetingNoteNavigation = (payload) => {
    c.meetingNavigations.push(payload);
    return new Promise((r) => (finish = r));
  };
  const one = c.respond();
  const two = c.respond();
  await new Promise(setImmediate);
  assert.equal(c.meetingNavigations.length, 1);
  const note = c.db.getNote(c.meetingNavigations[0].noteId);
  assert.equal(note.folder_id, folder.id);
  assert.equal(note.space_id, folder.space_id);
  finish({ success: true, value: note });
  assert.equal((await one).success, true);
  assert.equal((await two).success, true);
  assert.equal(c.db.getNotes().length, 1);
});

test("a linked root note requires current acknowledgment and is never moved or copied", async (t) => {
  const c = ownedNotification(t);
  if (!c) return;
  const note = c.db.saveNote("Linked", "", "meeting").note;
  c.db.updateNote(note.id, { calendar_event_id: "event", folder_id: null });
  const first = await c.respond();
  assert.equal(first.code, "LINKED_NOTE_CHANGED");
  assert.equal(first.context.existingNote.folderId, null);
  assert.equal(c.meetingNavigations.length, 0);
  assert.equal(c.db.getNotes().length, 1);
  const second = await c.respond({
    existingNote: { noteId: note.id, spaceId: note.space_id, folderId: null },
  });
  assert.equal(second.success, true);
  assert.equal(c.meetingNavigations[0].folderId, null);
  assert.equal(c.db.getNotes().length, 1);
});

test("unavailable explicit destination never falls back to Meetings", async (t) => {
  const c = ownedNotification(t);
  if (!c) return;
  c.owner.selectedDestination = { folderId: 999, spaceId: c.db.getPrivateSpaceId() };
  assert.equal((await c.respond()).code, "FOLDER_UNAVAILABLE");
  assert.equal(c.db.getNotes().length, 0);
  assert.equal(c.meetingNavigations.length, 0);
});

test("strict lookup failure and vanished acknowledged note never create a replacement", async (t) => {
  const c = ownedNotification(t);
  if (!c) return;
  const lookup = c.db.getOwnNoteByCalendarEventId;
  c.db.getOwnNoteByCalendarEventId = () => {
    throw Error("database busy");
  };
  assert.equal((await c.respond()).success, false);
  assert.equal(c.db.getNotes().length, 0);
  c.db.getOwnNoteByCalendarEventId = lookup;
  assert.equal(
    (await c.respond({ existingNote: { noteId: 999, spaceId: 1, folderId: null } })).code,
    "NOTE_UNAVAILABLE"
  );
  assert.equal(c.db.getNotes().length, 0);
});

test("navigation failure retains committed note and retries without duplicate writes", async (t) => {
  const c = ownedNotification(t);
  if (!c) return;
  let calls = 0;
  c.windowManager.queueMeetingNoteNavigation = async (payload) => {
    calls++;
    return calls === 1
      ? { success: false, code: "START_FAILED" }
      : { success: true, value: c.db.getNote(payload.noteId) };
  };
  assert.equal((await c.respond()).code, "START_FAILED");
  c.engine.handleCalendarReminder({ id: "next" });
  assert.equal(c.shown.length, 1, "a failed Start must not leave prompts suppressed");
  assert.equal(c.db.getNotes().length, 1);
  assert.equal((await c.respond()).success, true);
  assert.equal(c.db.getNotes().length, 1);
  assert.equal(calls, 2);
});

test("Join opens the link and suppresses new prompts while navigation is pending", async (t) => {
  const c = ownedNotification(t);
  if (!c) return;
  openedUrls.length = 0;
  c.owner.detection.event.hangout_link = "https://meet.example/join?pwd=1";
  let finish;
  c.windowManager.queueMeetingNoteNavigation = () => new Promise((r) => (finish = r));
  const joining = c.engine.handleNotificationResponse("calendar:event", "join", {}, c.owner);
  await new Promise(setImmediate);
  assert.deepEqual(openedUrls, ["https://meet.example/join?pwd=1"]);
  c.engine.handleCalendarReminder({ id: "next" });
  assert.equal(c.shown.length, 0);
  finish({ success: true });
  assert.equal((await joining).success, true);
});

test("coalesced audio detections cannot suppress the next meeting after a queued calendar prompt", () => {
  const { engine, shown } = createEngine();
  engine.setPreferences({ audioDetection: true, processDetection: true });
  engine._userRecording = true;
  engine._handleDetection("calendar", "event", { event: { summary: "Queued calendar" } });
  engine._handleDetection("audio", "sustained-audio", {});
  assert.equal(engine.activeDetections.size, 2);
  engine._userRecording = false;
  engine._flushNotificationQueue();
  assert.equal(shown.length, 1);
  assert.equal(engine.activeDetections.has("audio:sustained-audio"), false);
  engine.handleDetectionNotificationClosed("calendar:event");
  engine._handleDetection("audio", "sustained-audio", {});
  assert.equal(shown.length, 2);
});
