const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// A recording's note can vanish while it records: deleted on another device,
// or with its folder (here or elsewhere). Its later saves were refused and only
// logged, so the meeting was lost. The recording now goes on in a new note in
// Private holding what this session recorded, and nothing else of the note.
// A note the user deletes here still takes its transcript with it, kept on its
// tombstone in case the server denies the delete.

const OWNER = "account-1";
const NOTE_ID = 11;
const PRIVATE = { id: 1, kind: "private" };
const TEAM = { id: 2, kind: "team" };
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Standup",
  folderId: 5,
  autoEndEligible: true,
};
const SEED = [{ id: "seed-1", text: "said in an earlier session", source: "mic", timestamp: 1 }];

function createElectronAPI({ spaceId = PRIVATE.id } = {}) {
  const noopListener = () => () => {};
  const listeners = {};
  const capture = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      if (listeners[name] === callback) listeners[name] = null;
    };
  };
  const state = {
    stored: { id: NOTE_ID, title: "Standup", space_id: spaceId, folder_id: 5, deleted_at: null },
    accountId: OWNER,
    nextId: 500,
  };
  const writes = [];
  const saves = [];
  const kept = [];
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend: () => {},
    getNoteWriteGuard: async () => ({ accountId: state.accountId, authGeneration: 1 }),
    getNote: async (id) => (id === NOTE_ID ? state.stored : null),
    getSpaces: async () => [PRIVATE, TEAM],
    updateNote: async (id, patch) => {
      writes.push([id, patch]);
      if (id === NOTE_ID && !state.stored) return { success: false, error: "Note not found" };
      if (id === NOTE_ID && state.stored.deleted_at) {
        return { success: false, error: "Note was deleted", code: "note_deleted" };
      }
      return { success: true };
    },
    keepDeletedNoteTranscript: async (...args) => {
      kept.push(args);
      return state.keepAnswer ?? { success: true, id: args[0] };
    },
    saveNote: async (...args) => {
      saves.push(args);
      const [title, , , , , , spaceArg] = args;
      return {
        success: true,
        note: { id: state.nextId++, title, space_id: spaceArg ?? PRIVATE.id, folder_id: 9 },
      };
    },
    onMeetingTranscriptionSegment: capture("segment"),
    onNoteDeleted: capture("noteDeleted"),
    onFolderDeleted: capture("folderDeleted"),
    onNoteSynced: capture("noteSynced"),
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingDiarizationComplete: noopListener,
  };
  return { api, listeners, state, writes, saves, kept };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-vanished-note-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const final = (text) => ({ text, source: "mic", type: "final", timestamp: Date.now() });
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const transcriptWrites = (writes) =>
  writes.filter(([, patch]) => typeof patch.transcript === "string");

// Started, with the owner and the note's space read, and one line said.
async function startRecording(store, listeners, args = START_ARGS) {
  assert.equal(await store.startRecording(args), true);
  await settle();
  listeners.segment(final("said before the delete"));
}

test("a note deleted elsewhere mid-recording goes on in a new note in its Private", async (t) => {
  const { api, listeners, state, writes, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners, { ...START_ARGS, seedSegments: SEED });

  state.stored = null;
  listeners.noteDeleted({ id: NOTE_ID });
  await settle();

  assert.equal(saves.length, 1, "one copy");
  const [title, content, noteType, , , folderId, spaceId, transcript, guard] = saves[0];
  assert.deepEqual([title, content, noteType], ["", "", "meeting"], "none of the note's fields");
  assert.equal(folderId, null);
  assert.equal(spaceId, PRIVATE.id, "a Private note's copy stays in its Private");
  assert.match(transcript, /said before the delete/);
  assert.doesNotMatch(transcript, /earlier session/, "the note's earlier transcript stays out");
  assert.deepEqual(guard, { accountId: OWNER, authGeneration: 1 });

  const recording = store.useMeetingRecordingStore.getState();
  assert.equal(recording.recordingNoteId, 500, "the recording goes on in the copy");
  assert.deepEqual(recording.recordingCopy, {
    noteId: 500,
    spaceId: PRIVATE.id,
    folderId: 9,
    lostTitle: "Standup",
  });

  listeners.segment(final("said after the delete"));
  writes.length = 0;
  await store.persistLiveTranscript();
  const [[target, { transcript: saved }]] = transcriptWrites(writes);
  assert.equal(target, 500, "later saves go to the copy");
  assert.match(saved, /said after the delete/);
  assert.doesNotMatch(saved, /earlier session/);

  writes.length = 0;
  await store.stopRecording();
  assert.ok(
    transcriptWrites(writes).every(([id]) => id === 500),
    "and so does the stop's"
  );
});

test("a team note's recording goes on in the active workspace's Private", async (t) => {
  const { api, listeners, state, saves } = createElectronAPI({ spaceId: TEAM.id });
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  state.stored = null;
  listeners.noteDeleted({ id: NOTE_ID });
  await settle();

  assert.equal(saves[0][6], null, "main picks the Private");
  await store.stopRecording();
});

test("a folder delete that takes the recording's note starts the same copy", async (t) => {
  const { api, listeners, state, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  listeners.folderDeleted({ id: 7, noteIds: [12] });
  await settle();
  assert.equal(saves.length, 0, "another note's folder changes nothing");

  state.stored = { ...state.stored, deleted_at: "2026-11-19 10:00:00" };
  listeners.folderDeleted({ id: 5, noteIds: [NOTE_ID] });
  await settle();
  assert.equal(saves.length, 1);
  assert.equal(store.useMeetingRecordingStore.getState().recordingNoteId, 500);
  await store.stopRecording();
});

test("a note the user deletes here takes its transcript with it", async (t) => {
  const { api, listeners, state, writes, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  store.markRecordingNoteDeletedByUser(NOTE_ID);
  state.stored = { ...state.stored, deleted_at: "2026-11-19 10:00:00" };
  listeners.noteDeleted({ id: NOTE_ID });
  await settle();
  writes.length = 0;
  await store.persistLiveTranscript();
  await store.stopRecording();

  assert.equal(saves.length, 0, "no copy");
  assert.ok(
    transcriptWrites(writes).every(([id]) => id === NOTE_ID),
    "nothing goes elsewhere"
  );
  assert.equal(store.useMeetingRecordingStore.getState().recordingCopy, null);
});

// The user deleted it here and stopped before its delete was answered.
async function stopAfterUserDelete(store, listeners, state) {
  store.markRecordingNoteDeletedByUser(NOTE_ID);
  state.stored = { ...state.stored, deleted_at: "2026-11-19 10:00:00" };
  listeners.noteDeleted({ id: NOTE_ID });
  await settle();
  listeners.segment(final("said after the delete"));
  await store.stopRecording();
}

test("a stop after the user's delete keeps its final transcript on the tombstone", async (t) => {
  const { api, listeners, state, saves, kept } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);
  await stopAfterUserDelete(store, listeners, state);

  assert.equal(kept.length, 1);
  const [noteId, transcript, guard] = kept[0];
  assert.equal(noteId, NOTE_ID);
  assert.match(transcript, /said before the delete/);
  assert.match(transcript, /said after the delete/);
  assert.deepEqual(guard, { accountId: OWNER, authGeneration: 1 });
  assert.equal(saves.length, 0, "no copy");
});

test("a deleted note's transcript is kept only for the recording's account", async (t) => {
  const { api, listeners, state, kept } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);
  state.accountId = "account-2";
  await stopAfterUserDelete(store, listeners, state);

  assert.deepEqual(kept, []);
});

test("a note revived before its transcript was kept takes it as a save", async (t) => {
  const { api, listeners, state, writes, kept } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);
  state.keepAnswer = { success: false, id: NOTE_ID, code: "note_live" };
  await stopAfterUserDelete(store, listeners, state);

  assert.equal(kept.length, 1);
  const [target, { transcript }] = transcriptWrites(writes).at(-1);
  assert.equal(target, NOTE_ID);
  assert.match(transcript, /said after the delete/);
});

test("a delete that failed doesn't stop a later delete elsewhere from making a copy", async (t) => {
  const { api, listeners, state, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  const unmark = store.markRecordingNoteDeletedByUser(NOTE_ID);
  unmark();
  state.stored = null;
  listeners.noteDeleted({ id: NOTE_ID });
  await settle();

  assert.equal(saves.length, 1);
  await store.stopRecording();
});

test("a delete event for a note that is still there keeps the recording on it", async (t) => {
  const { api, listeners, writes, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  listeners.noteDeleted({ id: NOTE_ID });
  await settle();
  writes.length = 0;
  await store.persistLiveTranscript();

  assert.equal(saves.length, 0);
  assert.equal(transcriptWrites(writes)[0][0], NOTE_ID);
  await store.stopRecording();
});

test("a live save refused because the note is gone starts the copy", async (t) => {
  const { api, listeners, state, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  state.stored = { ...state.stored, deleted_at: "2026-11-19 10:00:00" };
  await store.persistLiveTranscript();
  await settle();

  assert.equal(saves.length, 1);
  assert.equal(store.useMeetingRecordingStore.getState().recordingNoteId, 500);
  await store.stopRecording();
});

test("a stop that finds the note gone saves its transcript to a new note", async (t) => {
  const { api, listeners, state, writes, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);
  listeners.segment(final("closing words"));

  state.stored = null;
  await store.stopRecording();

  assert.equal(saves.length, 1);
  assert.match(saves[0][7], /closing words/);
  assert.match(transcriptWrites(writes).at(-1)[1].transcript, /closing words/);
  assert.equal(transcriptWrites(writes).at(-1)[0], 500);
});

test("no copy is made for an account other than the one the recording started under", async (t) => {
  const { api, listeners, state, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  await startRecording(store, listeners);

  state.accountId = "account-2";
  state.stored = null;
  listeners.noteDeleted({ id: NOTE_ID });
  await settle();

  assert.equal(saves.length, 0);
  assert.equal(store.useMeetingRecordingStore.getState().recordingNoteId, NOTE_ID);
  await store.stopRecording();
});

test("the editor's edits to the recording's vanished note join the recording's copy", async (t) => {
  const { api, listeners, state, saves } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.rescueRecordingNote(NOTE_ID), null, "nothing records yet");
  await startRecording(store, listeners);

  state.stored = null;
  listeners.noteDeleted({ id: NOTE_ID });
  // Asked while the event's copy is still being made.
  assert.equal(await store.rescueRecordingNote(NOTE_ID), 500);
  assert.equal(saves.length, 1, "one copy, whoever asks first");
  assert.equal(await store.rescueRecordingNote(12), null, "another note isn't the recording's");
  await store.stopRecording();
});

test("a folder delete is refused only while it holds the note being recorded", async (t) => {
  const { api, listeners } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(store.recordingNoteInFolders(new Set([5])), null, "nothing records");

  await startRecording(store, listeners);
  assert.equal((await store.recordingNoteInFolders(new Set([5])))?.id, NOTE_ID);
  assert.equal(await store.recordingNoteInFolders(new Set([6])), null);
  await store.stopRecording();
});
