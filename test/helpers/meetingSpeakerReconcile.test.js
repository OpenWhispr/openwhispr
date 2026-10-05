const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const handlersModulePath = require.resolve("../../src/helpers/ipcHandlers");
const identifierModulePath = require.resolve("../../src/helpers/liveSpeakerIdentifier");
const originalLoad = Module._load;

const electronStub = {
  app: {
    getPath: () => "/tmp",
    getName: () => "test",
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => {},
    requestSingleInstanceLock: () => true,
  },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class BrowserWindow {
    static getAllWindows() {
      return [];
    }
  },
  shell: {},
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 0, height: 0 } }) },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
  clipboard: {},
  nativeImage: {},
  globalShortcut: {},
  utilityProcess: {},
  MessageChannelMain: class {},
};

// ipcHandlers pulls in a large module graph; stub the process boundaries and
// capture broadcasts so the prototype methods can run against a fake `this`.
function loadHandlers() {
  delete require.cache[handlersModulePath];
  delete require.cache[identifierModulePath];
  const broadcasts = [];

  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "electron") {
      return electronStub;
    }
    if (request === "./windowBroadcast" && parent?.filename === handlersModulePath) {
      return {
        broadcastToWindows: (channel, payload) => {
          broadcasts.push({ channel, payload });
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const IPCHandlers = require(handlersModulePath);
    const liveSpeakerIdentifier = require(identifierModulePath);
    return { IPCHandlers, liveSpeakerIdentifier, broadcasts };
  } finally {
    Module._load = originalLoad;
  }
}

function createMappingRecorder(existingMappings) {
  const calls = { set: [], remove: [] };
  const databaseManager = {
    getSpeakerMappings: () => existingMappings,
    setSpeakerMapping: (noteId, speakerId, profileId, displayName) => {
      calls.set.push({ noteId, speakerId, profileId, displayName });
    },
    removeSpeakerMapping: (noteId, speakerId) => {
      calls.remove.push({ noteId, speakerId });
    },
  };
  return { calls, databaseManager };
}

const NOTE_ID = 42;
const embedding = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));

function reconcile(IPCHandlers, databaseManager, liveSpeakerId) {
  const fakeThis = Object.assign(Object.create(IPCHandlers.prototype), { databaseManager });
  const liveState = {
    [liveSpeakerId]: {
      displayName: "Alice",
      profileId: 5,
      noteId: NOTE_ID,
      embedding,
    },
  };
  const segments = [];
  return IPCHandlers.prototype._reconcileLiveSpeakerState.call(
    fakeThis,
    liveState,
    { speaker_0: embedding },
    segments
  );
}

test("reconciliation keeps the mapping when live and offline ids already match", () => {
  const { IPCHandlers } = loadHandlers();
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_0", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(IPCHandlers, databaseManager, "speaker_0");

  assert.equal(calls.set.length, 1);
  assert.deepEqual(calls.set[0], {
    noteId: NOTE_ID,
    speakerId: "speaker_0",
    profileId: 5,
    displayName: "Alice",
  });
  assert.deepEqual(
    calls.remove,
    [],
    "removing the row that was just upserted deletes the user's identification"
  );
});

test("reconciliation migrates the mapping when the offline id differs", () => {
  const { IPCHandlers } = loadHandlers();
  const { calls, databaseManager } = createMappingRecorder([
    { speaker_id: "speaker_3", display_name: "Alice", profile_id: 5 },
  ]);

  reconcile(IPCHandlers, databaseManager, "speaker_3");

  assert.equal(calls.set.length, 1);
  assert.equal(calls.set[0].speakerId, "speaker_0");
  assert.deepEqual(calls.remove, [{ noteId: NOTE_ID, speakerId: "speaker_3" }]);
});

const THREE_ATTENDEES = [
  { email: "one@example.com" },
  { email: "two@example.com" },
  { email: "three@example.com" },
];

function refreshConfig(explicit, { expectedCount = 2, attendees = THREE_ATTENDEES } = {}) {
  const { IPCHandlers, liveSpeakerIdentifier, broadcasts } = loadHandlers();
  const fakeThis = Object.assign(Object.create(IPCHandlers.prototype), {
    activeMeetingSpeakerConfig: { enabled: true, expectedCount, explicit },
    _activeMeetingNoteId: NOTE_ID,
    databaseManager: { getGoogleAccounts: () => [] },
  });
  const note = { participants: JSON.stringify(attendees) };

  IPCHandlers.prototype._refreshMeetingSpeakerConfigFromNote.call(fakeThis, NOTE_ID, note);
  return { fakeThis, liveSpeakerIdentifier, broadcasts };
}

test("roster changes refresh an auto-derived speaker config", () => {
  const { fakeThis, liveSpeakerIdentifier, broadcasts } = refreshConfig(false);

  assert.equal(fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
  assert.equal(liveSpeakerIdentifier.maxSpeakers, 3);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].channel, "meeting-session-speaker-config-updated");
  assert.deepEqual(broadcasts[0].payload, { enabled: true, expectedCount: 4 });
});

test("an explicit stepper count is never overridden by roster changes", () => {
  const { fakeThis, broadcasts } = refreshConfig(true);

  assert.equal(fakeThis.activeMeetingSpeakerConfig.expectedCount, 2);
  assert.deepEqual(broadcasts, []);
});

// Lowering the cap below the clusters already discovered makes the identifier
// fold every later voice onto an existing speaker — the collapse this refresh
// exists to prevent. A shrinking or emptied roster must be ignored.
test("a shrinking roster leaves the speaker cap untouched", () => {
  const shrunk = refreshConfig(false, {
    expectedCount: 4,
    attendees: [{ email: "one@example.com" }],
  });

  assert.equal(shrunk.fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
  assert.deepEqual(shrunk.broadcasts, []);

  const emptied = refreshConfig(false, { expectedCount: 4, attendees: [] });

  assert.equal(emptied.fakeThis.activeMeetingSpeakerConfig.expectedCount, 4);
  assert.deepEqual(emptied.broadcasts, []);
});

function makeExpectationResolver() {
  const { IPCHandlers } = loadHandlers();
  return (args) =>
    IPCHandlers.prototype._resolveSpeakerExpectation.call(
      Object.assign(Object.create(IPCHandlers.prototype), {
        databaseManager: { getNote: () => args.note ?? null },
      }),
      {
        sessionConfig: args.sessionConfig ?? null,
        noteId: args.noteId ?? null,
        observedSpeakerIds: args.observedSpeakerIds ?? new Set(),
        diarizedSource: args.diarizedSource,
      }
    );
}

// System mode: only system audio reaches the diarizer (the mic track is "you"),
// so every branch must report `cap` as a count of other speakers (total - 1).
// The no-signal fallback used to return the total itself, which let one remote
// voice split across two labels.
test("speaker expectation reports cap as other-speaker count in every system-mode branch", () => {
  const resolve = makeExpectationResolver();

  assert.deepEqual(
    resolve({ sessionConfig: { expectedCount: 3, explicit: true } }),
    { numSpeakers: 2, cap: 2 },
    "an explicit count of 3 means 2 other speakers"
  );
  assert.deepEqual(
    resolve({ noteId: NOTE_ID, note: { expected_speaker_count: 4 } }),
    { numSpeakers: 3, cap: 3 },
    "a note count outranks a non-explicit session config"
  );
  assert.deepEqual(
    resolve({ observedSpeakerIds: new Set(["speaker_0", "speaker_1"]) }),
    { numSpeakers: 2, cap: 2 },
    "observed ids are already other-speaker ids"
  );
  assert.deepEqual(
    resolve({}),
    { numSpeakers: -1, cap: 1 },
    "the default total of 2 means a single other speaker, not 2"
  );
});

// Mic mode (in-person session): the user is one of the diarized voices, so the
// expected total applies without the -1 the system-mode branches use.
test("mic mode counts the user among the expected speakers", () => {
  const resolve = makeExpectationResolver();

  assert.deepEqual(
    resolve({ sessionConfig: { expectedCount: 3, explicit: true }, diarizedSource: "mic" }),
    { numSpeakers: 3, cap: 3 },
    "an explicit total of 3 stays 3, not total - 1"
  );
  assert.deepEqual(
    resolve({ diarizedSource: "mic" }),
    { numSpeakers: -1, cap: 2 },
    "the no-signal fallback caps at the default expected total, user included"
  );
});
