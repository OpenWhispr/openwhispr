const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Drives the real startRecording/stopRecording flow through the renderer
// harness and pins the meeting-system-audio-silent warning: latched once per
// recording, cleared on stop, and never set for a session without system audio.

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
};

function createElectronAPI({ systemAudioMode, systemAudioStrategy }) {
  const listeners = { systemAudioSilent: null };
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
    onMeetingSystemAudioSilent: (callback) => {
      listeners.systemAudioSilent = callback;
      return () => {
        if (listeners.systemAudioSilent === callback) listeners.systemAudioSilent = null;
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
    cachePrefix: "openwhispr-meeting-system-audio-silence-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

// Minimal Web Audio + capture stubs so the mic pipeline can run under Node.
function installMicCaptureGlobals(t) {
  const track = {
    readyState: "live",
    label: "Fake Mic",
    stop() {},
    getSettings: () => ({}),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  };
  const mediaDevices = {
    getUserMedia: async () => stream,
    enumerateDevices: async () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const node = () => ({
    connect() {},
    disconnect() {},
    gain: { value: 0 },
    fftSize: 0,
    smoothingTimeConstant: 0,
  });
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async () => {} };
      this.destination = {};
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return node();
    }
    createAnalyser() {
      return node();
    }
    async resume() {}
    async close() {}
  }
  class FakeAudioWorkletNode {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
    connect() {}
    disconnect() {}
  }

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices },
    configurable: true,
    writable: true,
  });
  globalThis.AudioContext = FakeAudioContext;
  globalThis.AudioWorkletNode = FakeAudioWorkletNode;
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    delete globalThis.AudioContext;
    delete globalThis.AudioWorkletNode;
  });
}

test("silence event latches the warning once during a system-audio session", async (t) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioSilentWarning, false);
  assert.equal(typeof listeners.systemAudioSilent, "function");

  listeners.systemAudioSilent({ systemAudioStrategy: "native" });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioSilentWarning, true);

  // A repeated event must not re-set state (the UI toasts on the transition).
  let notifications = 0;
  const unsubscribe = store.useMeetingRecordingStore.subscribe(() => {
    notifications += 1;
  });
  listeners.systemAudioSilent({ systemAudioStrategy: "native" });
  unsubscribe();
  assert.equal(notifications, 0);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioSilentWarning, true);

  await store.stopRecording();
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioSilentWarning, false);
});

test("a silence event arriving after stop is ignored without crashing", async (t) => {
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "native",
    systemAudioStrategy: "native",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const lateCallback = listeners.systemAudioSilent;
  await store.stopRecording();

  lateCallback({ systemAudioStrategy: "native" });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioSilentWarning, false);
});

test("no warning when the session had no system audio", async (t) => {
  installMicCaptureGlobals(t);
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "unsupported",
    systemAudioStrategy: "unsupported",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
  assert.equal(store.useMeetingRecordingStore.getState().micCaptureStatus, "active");

  listeners.systemAudioSilent({ systemAudioStrategy: "unsupported" });
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioSilentWarning, false);

  await store.stopRecording();
});
