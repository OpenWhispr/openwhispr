const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// A window reload mid-recording (Sign in, SSO completion, the crash screen's
// Reload) replaces this renderer: main's owner-loss teardown ends the session
// and the store's module state goes with the page, so stopRecording never
// writes what was said since the last 30-second save. The store writes the
// live transcript on beforeunload instead. Chromium dispatches it before a
// renderer reload and before main's loadURL/loadFile alike, while the page can
// still reach main.

const NOTE_ID = 11;
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ stopResult = async () => ({ success: true }) } = {}) {
  const noopListener = () => () => {};
  const listeners = {};
  const capture = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      if (listeners[name] === callback) listeners[name] = null;
    };
  };
  const writes = [];
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
    meetingTranscriptionStop: () => stopResult(),
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async (id, patch) => {
      writes.push([id, patch]);
      return { success: true };
    },
    onMeetingTranscriptionSegment: capture("segment"),
    onNoteDeleted: capture("noteDeleted"),
    onNoteSynced: capture("noteSynced"),
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingDiarizationComplete: noopListener,
  };
  return { api, listeners, writes };
}

async function loadStore(t, api) {
  const windowListeners = new Map();
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      addEventListener: (type, listener) => {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
      },
      removeEventListener: (type, listener) => {
        windowListeners.set(
          type,
          (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener)
        );
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-unload-flush-test-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const unloadListeners = () => windowListeners.get("beforeunload") ?? [];
  // Runs the handlers the way the page would, synchronously and to completion.
  const unload = () => {
    const event = {
      type: "beforeunload",
      defaultPrevented: false,
      returnValue: "",
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    const results = unloadListeners().map((listener) => listener(event));
    return { event, results };
  };
  return { store, unload, unloadListeners, vite };
}

const transcriptWrites = (writes) =>
  writes.filter(([, patch]) => typeof patch.transcript === "string");

const final = (text) => ({ text, source: "mic", type: "final", timestamp: Date.now() });
const deleteNote = (listeners, id) => listeners.noteDeleted?.({ id });
const syncNote = (listeners, note) => listeners.noteSynced?.(note);

// Lets a stop reach its first real await (the audio flush timer).
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("a reload mid-recording writes the live transcript as the page unloads", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const { store, unload } = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.segment(final("said after the last save"));
  writes.length = 0;

  const { event, results } = unload();

  // Checked before any await: nothing after the handler returns is sure to run.
  const flushed = transcriptWrites(writes);
  assert.equal(flushed.length, 1, "the live transcript is written as the window unloads");
  assert.equal(flushed[0][0], NOTE_ID);
  assert.match(flushed[0][1].transcript, /said after the last save/);
  // A cancelled unload fails main's loadURL and prompts on a reload.
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.returnValue, "");
  assert.ok(results.every((result) => result === undefined));

  // Same serialization the stop path writes, so diarization merges either one.
  writes.length = 0;
  await store.stopRecording();
  assert.equal(transcriptWrites(writes).at(-1)[1].transcript, flushed[0][1].transcript);
});

test("the unload listener is registered once, at module load", async (t) => {
  const { api } = createElectronAPI();
  const { store, unloadListeners } = await loadStore(t, api);
  assert.equal(unloadListeners().length, 1);

  assert.equal(await store.startRecording(START_ARGS), true);
  await store.stopRecording();
  assert.equal(await store.startRecording(START_ARGS), true);
  await store.stopRecording();

  assert.equal(unloadListeners().length, 1, "sessions must not stack listeners");
});

test("an unload with nothing to save writes nothing", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const { store, unload } = await loadStore(t, api);

  unload();
  assert.deepEqual(transcriptWrites(writes), [], "no recording");

  assert.equal(await store.startRecording(START_ARGS), true);
  unload();
  assert.deepEqual(transcriptWrites(writes), [], "no segments yet");
  await store.stopRecording();

  assert.equal(await store.startRecording({ ...START_ARGS, noteId: null }), true);
  listeners.segment(final("no note to hold this"));
  unload();
  assert.deepEqual(transcriptWrites(writes), [], "no note");
  await store.stopRecording();
});

test("an unload during a stop neither duplicates nor overwrites its final write", async (t) => {
  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const { api, listeners, writes } = createElectronAPI({ stopResult: () => stopGate });
  const { store, unload } = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.segment(final("closing words"));
  writes.length = 0;

  const stopping = store.stopRecording();
  await settle();
  assert.equal(transcriptWrites(writes).length, 1, "the stop wrote its final transcript");

  unload();
  assert.equal(transcriptWrites(writes).length, 1, "the flush stays out of a stop");

  releaseStop({ success: true });
  await stopping;
});

test("a note deleted mid-recording is not written back from its tombstone", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const { store, unload } = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.segment(final("said before the delete"));

  deleteNote(listeners, 12);
  writes.length = 0;
  unload();
  assert.equal(transcriptWrites(writes).length, 1, "another note's delete changes nothing");

  deleteNote(listeners, NOTE_ID);
  writes.length = 0;
  unload();
  assert.deepEqual(transcriptWrites(writes), []);
  await store.stopRecording();

  // The guard belongs to that recording, not to every later one.
  assert.equal(await store.startRecording({ ...START_ARGS, noteId: 12 }), true);
  listeners.segment(final("a new meeting"));
  writes.length = 0;
  unload();
  assert.equal(transcriptWrites(writes).length, 1);
  await store.stopRecording();
});

// A team-note delete the server denies (stale admin permissions) revives the
// same row, and the snapshot pull that follows re-syncs it as a live note.
test("a recording note restored after a denied delete is saved again", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const { store, unload } = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.segment(final("said before the delete"));
  deleteNote(listeners, NOTE_ID);

  // A pull racing the delete re-syncs the row with its tombstone intact.
  syncNote(listeners, { id: NOTE_ID, deleted_at: "2026-09-23 10:00:00" });
  syncNote(listeners, { id: 12, deleted_at: null });
  writes.length = 0;
  unload();
  assert.deepEqual(transcriptWrites(writes), [], "still a tombstone");

  syncNote(listeners, { id: NOTE_ID, deleted_at: null });
  listeners.segment(final("said after the restore"));
  writes.length = 0;
  unload();
  const flushed = transcriptWrites(writes);
  assert.equal(flushed.length, 1, "the restored note is saved again");
  assert.match(flushed[0][1].transcript, /said after the restore/);
  await store.stopRecording();
});

test("a resumed recording's unload keeps the transcript it resumed from", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const { store, unload } = await loadStore(t, api);
  const seedSegments = [
    { id: "seed-1", text: "from the first half", source: "mic", timestamp: 1 },
  ];
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
  listeners.segment(final("from the second half"));
  writes.length = 0;

  unload();

  const [[, { transcript }]] = transcriptWrites(writes);
  assert.match(transcript, /from the first half/, "an unload must not truncate the note");
  assert.match(transcript, /from the second half/);
  await store.stopRecording();
});

// The 30-second saver fires this without awaiting, so a failure must never escape.
for (const [name, updateNote] of [
  [
    "a thrown live save",
    async () => {
      throw new Error("database closed");
    },
  ],
  ["a refused live save", async () => ({ success: false, error: "Note not found" })],
]) {
  test(`${name} is logged, never thrown`, async (t) => {
    const { api, listeners } = createElectronAPI();
    api.updateNote = updateNote;
    const { store, vite } = await loadStore(t, api);
    const { default: logger } = await vite.ssrLoadModule("/utils/logger.ts");
    const logged = t.mock.method(logger, "error", () => {});
    assert.equal(await store.startRecording(START_ARGS), true);
    listeners.segment(final("said as the save failed"));

    await assert.doesNotReject(store.persistLiveTranscript());
    assert.ok(
      logged.mock.calls.some(
        ({ arguments: [message] }) => message === "Failed to persist live meeting transcript"
      ),
      "the failed save is logged"
    );
    await store.stopRecording();
  });
}
