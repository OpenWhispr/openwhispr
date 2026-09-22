const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Delayed diarization is always persisted to the note that owns its session.
// Publishing it to the UI is separate, and must not happen while a recording is
// still appending to that same note: the editor prefers a published overlay to
// the note's own text, so the live half would look like it had vanished.

const NOTE_ID = 11;
const START_ARGS = { noteId: NOTE_ID, noteTitle: "Standup", folderId: null, autoEndEligible: true };

function createElectronAPI() {
  const noopListener = () => () => {};
  const state = { diarizationCallback: null, updatedTranscripts: [] };
  const notes = new Map([[NOTE_ID, { id: NOTE_ID, transcript: "", deleted_at: null }]]);
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
    meetingTranscriptionStop: async () => ({ success: true, diarizationSessionId: null }),
    meetingTranscriptionSend: () => {},
    getNote: async (id) => notes.get(id) ?? null,
    updateNote: async (id, patch) => {
      state.updatedTranscripts.push({ id, transcript: patch.transcript });
      const note = notes.get(id);
      if (note) note.transcript = patch.transcript;
      return { success: true };
    },
    saveNoteSpeakerEmbeddings: async () => ({ success: true }),
    onMeetingDiarizationComplete: (callback) => {
      state.diarizationCallback = callback;
      return () => {
        state.diarizationCallback = null;
      };
    },
    onMeetingTranscriptionSegment: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };
  return { api, state };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-diarization-publish-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const ENRICHED = [{ id: "d0", text: "hello there", speaker: "speaker_0", speakerName: "Ada" }];

// The serial queue behind the listener awaits getNote and updateNote.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("a finished session's diarization is not published over the recording that resumed its note", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(typeof state.diarizationCallback, "function");

  assert.equal(await store.startRecording(START_ARGS), true);
  state.updatedTranscripts.length = 0;

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-before-restart",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(
    store.useMeetingRecordingStore.getState().completedDiarization,
    null,
    "the finished half must not paint over the live recording"
  );
  // Suppressing the overlay must not cost the enrichment its write.
  assert.equal(state.updatedTranscripts.length, 1);
  assert.match(state.updatedTranscripts[0].transcript, /Ada/);

  await store.stopRecording();
});

test("the same result publishes normally once the recording has stopped", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-after-stop",
    segments: ENRICHED,
  });
  await settle();

  const published = store.useMeetingRecordingStore.getState().completedDiarization;
  assert.equal(published?.noteId, NOTE_ID);
  assert.equal(published?.segments.length, 1);
});

test("a live recording on another note does not suppress the publish", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, noteId: 99 }), true);

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-other-note",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(store.useMeetingRecordingStore.getState().completedDiarization?.noteId, NOTE_ID);
  await store.stopRecording();
});
