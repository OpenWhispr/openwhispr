const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// `stopped` is what gates the auto-end restart card: true means this call ended
// a live recording, so resuming its note is safe. It must not be conditioned on
// main's teardown result — the transcript is written from the renderer before
// that IPC is even awaited, so a teardown error still leaves a resumable note.

const START_ARGS = {
  noteId: 11,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ stopResult }) {
  const noopListener = () => () => {};
  const notes = new Map([[11, { id: 11, transcript: "", deleted_at: null }]]);
  return {
    updatedTranscripts: [],
    api: {
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
      meetingTranscriptionStop: async () => stopResult(),
      meetingTranscriptionSend: () => {},
      getNote: async (id) => notes.get(id) ?? null,
      updateNote: async () => ({ success: true }),
      onMeetingTranscriptionSegment: noopListener,
      onMeetingSpeakerIdentified: noopListener,
      onMeetingSpeakersMerged: noopListener,
      onMeetingSessionSpeakerConfigUpdated: noopListener,
      onMeetingTranscriptionError: noopListener,
      onMeetingTranscriptionFatalError: noopListener,
      onMeetingSystemAudioSilent: noopListener,
      onMeetingDiarizationComplete: noopListener,
    },
  };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-auto-end-stop-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

test("a completed stop reports that it ended the recording", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

// The renderer has already run cleanup and written the transcript by the time
// main's result is read, so a teardown failure must not cost the user their
// restart offer.
test("a stop whose main-side teardown fails still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => ({ success: false, error: "audio tap teardown failed" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording();

  assert.equal(result.stopped, true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
});

test("a stop main already dropped as stale still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => ({ success: false, reason: "stale-session" }),
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("a stop that rejects still reports the recording ended", async (t) => {
  const { api } = createElectronAPI({
    stopResult: () => {
      throw new Error("ipc channel closed");
    },
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal((await store.stopRecording()).stopped, true);
});

test("stopping when nothing is recording reports no stop happened", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal((await store.stopRecording()).stopped, false);
});

test("a scoped stop for another session reports no stop happened", async (t) => {
  const { api } = createElectronAPI({ stopResult: () => ({ success: true }) });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const result = await store.stopRecording("some-other-session");

  assert.equal(result.stopped, false);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  await store.stopRecording();
});
