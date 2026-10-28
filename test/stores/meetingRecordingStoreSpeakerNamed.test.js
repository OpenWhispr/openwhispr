const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Main names a voice from the meeting app after its first rows were already
// confirmed (meeting-speaker-named). Those rows take the name; rows the user
// locked, rows not yet confirmed as that voice, and another session's rows
// don't.

const NOTE_ID = 31;
const START_ARGS = { noteId: NOTE_ID, noteTitle: "Sync", folderId: null, autoEndEligible: true };

function createElectronAPI() {
  const noopListener = () => () => {};
  const state = { startOptions: [], namedCallback: null };
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async (options) => {
      state.startOptions.push(options);
      return { success: true, systemAudioMode: "native", systemAudioStrategy: "native" };
    },
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true, diarizationSessionId: null }),
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async () => ({ success: true }),
    onMeetingDiarizationComplete: noopListener,
    onMeetingTranscriptionSegment: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSpeakerNamed: (callback) => {
      state.namedCallback = callback;
      return () => {
        state.namedCallback = null;
      };
    },
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
    cachePrefix: "openwhispr-meeting-speaker-named-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

function rows() {
  const now = Date.now();
  const row = (id, extra) => ({
    id,
    text: id,
    source: "system",
    timestamp: now - 1_000,
    speakerIsPlaceholder: false,
    ...extra,
  });
  return [
    row("confirmed", { speaker: "speaker_4" }),
    row("locked", { speaker: "speaker_6", speakerName: "Janet", speakerLocked: true }),
    row("placeholder", { speaker: "speaker_4", speakerIsPlaceholder: true }),
    row("provisional", { speaker: "speaker_4", speakerStatus: "provisional" }),
    row("someone else", { speaker: "speaker_5" }),
  ];
}

const nameOf = (store, text) =>
  store.useMeetingRecordingStore.getState().segments.find((segment) => segment.text === text)
    ?.speakerName;

test("asks main for the meeting-app labels only when the setting is on", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(state.startOptions[0].appSpeakerLabelsEnabled, false);
  await store.stopRecording();
});

test("a voice the meeting app names renames only its confirmed rows", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: rows() }), true);
  assert.equal(typeof state.namedCallback, "function");
  state.namedCallback({ speakerId: "speaker_4", displayName: "Jane Doe" });

  assert.equal(nameOf(store, "confirmed"), "Jane Doe");
  assert.notEqual(nameOf(store, "placeholder"), "Jane Doe");
  assert.notEqual(nameOf(store, "provisional"), "Jane Doe");
  assert.notEqual(nameOf(store, "someone else"), "Jane Doe");
  await store.stopRecording();
});

test("a voice the user named keeps their name", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: rows() }), true);
  state.namedCallback({ speakerId: "speaker_6", displayName: "Jane Doe" });
  assert.equal(nameOf(store, "locked"), "Janet");
  await store.stopRecording();
});

test("a name for an ended session changes nothing", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: rows() }), true);
  const named = state.namedCallback;
  await store.stopRecording();

  named?.({ speakerId: "speaker_4", displayName: "Jane Doe" });
  assert.notEqual(nameOf(store, "confirmed"), "Jane Doe");
});
