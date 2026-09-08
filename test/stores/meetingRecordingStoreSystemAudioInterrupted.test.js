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
  const listeners = { systemAudioInterrupted: null, systemAudioResumed: null };
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
    onMeetingSystemAudioResumed: (callback) => {
      listeners.systemAudioResumed = callback;
      return () => {
        if (listeners.systemAudioResumed === callback) listeners.systemAudioResumed = null;
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

async function startWithPendingMicrophone(t, startResult) {
  installMicCaptureGlobals(t);
  const micStream = await navigator.mediaDevices.getUserMedia();
  const microphone = Promise.withResolvers();
  const micRequested = Promise.withResolvers();
  const mainStarted = Promise.withResolvers();
  navigator.mediaDevices.getUserMedia = () => {
    micRequested.resolve();
    return microphone.promise;
  };
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const startMain = api.meetingTranscriptionStart;
  api.meetingTranscriptionStart = async () => {
    mainStarted.resolve();
    return startResult ?? startMain();
  };
  const store = await loadStore(t, api);
  const starting = store.startRecording(START_ARGS);
  const finishStart = async () => {
    microphone.resolve(micStream);
    await starting;
  };
  t.after(async () => {
    await finishStart();
    await store.stopRecording();
  });
  await Promise.all([mainStarted.promise, micRequested.promise]);
  return { api, listeners, store, finishStart };
}

const stoppedCapture = {
  systemAudioStrategy: "native",
  reason: "no_audio_delivered",
  recovering: false,
};

test("the final startup interruption survives a pending microphone permission", async (t) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    listeners.systemAudioInterrupted?.({ ...stoppedCapture, recovering: true });
  }
  listeners.systemAudioInterrupted?.(stoppedCapture);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);

  await finishStart();

  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "no_audio_delivered",
  });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 1);
});

test("resumed audio discards a quiet warning buffered during microphone setup", async (t) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  listeners.systemAudioInterrupted?.({ ...stoppedCapture, reason: "gone_quiet" });
  listeners.systemAudioResumed?.();
  await finishStart();
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 0);
});

test("resumed audio preserves a capture-loss warning buffered during microphone setup", async (t) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  listeners.systemAudioInterrupted?.(stoppedCapture);
  listeners.systemAudioResumed?.();
  await finishStart();
  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "no_audio_delivered",
  });
});

test("a mic-only fallback discards buffered system-audio interruptions", async (t) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t, {
    success: true,
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });
  listeners.systemAudioInterrupted?.(stoppedCapture);
  await finishStart();
  listeners.systemAudioInterrupted?.(stoppedCapture);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 0);
});

test("failed startup removes early interruption listeners before another session", async (t) => {
  const { api, listeners, store, finishStart } = await startWithPendingMicrophone(t, {
    success: false,
    error: "capture startup failed",
  });
  const lateInterrupted = listeners.systemAudioInterrupted;
  const lateResumed = listeners.systemAudioResumed;
  listeners.systemAudioInterrupted?.(stoppedCapture);
  await finishStart();
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(listeners.systemAudioInterrupted, null);
  assert.equal(listeners.systemAudioResumed, null);

  api.meetingTranscriptionStart = async () => ({
    success: true,
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  await store.startRecording(START_ARGS);
  listeners.systemAudioInterrupted({ ...stoppedCapture, reason: "gone_quiet" });
  lateInterrupted?.(stoppedCapture);
  lateResumed?.();
  assert.equal(
    store.useMeetingRecordingStore.getState().systemAudioInterrupted.reason,
    "gone_quiet"
  );
});

test("stopping during microphone setup discards buffered warnings and early listeners", async (t) => {
  const { listeners, store, finishStart } = await startWithPendingMicrophone(t);
  listeners.systemAudioInterrupted?.(stoppedCapture);
  const stopping = store.stopRecording();
  await finishStart();
  await stopping;
  assert.equal(listeners.systemAudioInterrupted, null);
  assert.equal(listeners.systemAudioResumed, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, 0);
});

test("resumed audio clears only quiet warnings without creating another interruption", async (t) => {
  installMicCaptureGlobals(t);
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const store = await loadStore(t, api);
  t.after(() => store.stopRecording());
  await store.startRecording(START_ARGS);
  listeners.systemAudioInterrupted({ ...stoppedCapture, reason: "gone_quiet" });
  const nonce = store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce;
  listeners.systemAudioResumed?.();
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterruptedNonce, nonce);
  for (const recovering of [true, false]) {
    listeners.systemAudioInterrupted({ ...stoppedCapture, recovering });
    listeners.systemAudioResumed?.();
    assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
      reason: "no_audio_delivered",
      recovering,
    });
  }

  const lateResumed = listeners.systemAudioResumed;
  await store.stopRecording();
  await store.startRecording(START_ARGS);
  listeners.systemAudioInterrupted({ ...stoppedCapture, reason: "gone_quiet" });
  lateResumed?.();
  assert.equal(
    store.useMeetingRecordingStore.getState().systemAudioInterrupted.reason,
    "gone_quiet"
  );
});

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
