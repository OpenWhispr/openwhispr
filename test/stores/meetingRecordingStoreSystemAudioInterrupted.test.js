const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Sibling of meetingRecordingStoreSystemAudioSilence: that warning latches once
// per recording, this one repeats, because capture can stop and be restarted
// several times in one call and each break is worth surfacing (#1990).

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
};

function createElectronAPI({ systemAudioMode, systemAudioStrategy }) {
  const listeners = { systemAudioInterrupted: null };
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: systemAudioMode !== "unsupported",
      status: systemAudioMode === "unsupported" ? "unsupported" : "granted",
      mode: systemAudioMode,
      strategy: systemAudioStrategy,
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      systemAudioMode,
      systemAudioStrategy,
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend: () => {},
    onMeetingTranscriptionSegment: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingSystemAudioInterrupted: (callback) => {
      listeners.systemAudioInterrupted = callback;
      return () => {
        if (listeners.systemAudioInterrupted === callback) {
          listeners.systemAudioInterrupted = null;
        }
      };
    },
  };
  return { api, listeners };
}

async function loadStore(t, api) {
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-system-audio-interrupted-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

test("every interruption bumps the nonce so a repeat still notifies", async (t) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(typeof listeners.systemAudioInterrupted, "function");

  listeners.systemAudioInterrupted({
    systemAudioStrategy: "native",
    reason: "no_audio_delivered",
    recovering: true,
  });
  let state = store.useMeetingRecordingStore.getState();
  assert.deepEqual(state.systemAudioInterrupted, {
    recovering: true,
    reason: "no_audio_delivered",
  });
  const firstNonce = state.systemAudioInterruptedNonce;

  listeners.systemAudioInterrupted({
    systemAudioStrategy: "native",
    reason: "device_invalidated",
    recovering: true,
  });
  state = store.useMeetingRecordingStore.getState();
  assert.equal(state.systemAudioInterruptedNonce, firstNonce + 1);

  await store.stopRecording();
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
});

// The reason has to survive the hop: the toast copy for a quiet call is much
// weaker than the one for capture that has actually stopped, and only the
// reason separates them.
test("a give-up report carries recovering false and its reason through to the store", async (t) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.systemAudioInterrupted({
    systemAudioStrategy: "native",
    reason: "gone_quiet",
    recovering: false,
  });

  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "gone_quiet",
  });

  listeners.systemAudioInterrupted({
    systemAudioStrategy: "native",
    reason: "no_audio_delivered",
    recovering: false,
  });
  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "no_audio_delivered",
  });

  await store.stopRecording();
});

test("an interruption arriving after stop is ignored without crashing", async (t) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const lateCallback = listeners.systemAudioInterrupted;
  await store.stopRecording();

  lateCallback({
    systemAudioStrategy: "native",
    reason: "no_audio_delivered",
    recovering: true,
  });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
});

test("no interruption state when the session had no system audio", async (t) => {
  installMicCaptureGlobals(t);
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().micCaptureStatus, "active");

  listeners.systemAudioInterrupted({
    systemAudioStrategy: "unsupported",
    reason: "no_audio_delivered",
    recovering: true,
  });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);

  await store.stopRecording();
});
