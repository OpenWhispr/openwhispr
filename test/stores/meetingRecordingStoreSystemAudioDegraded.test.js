const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Pins the mid-session takeover: when main reports that a native system-audio
// helper is capturing silence, the renderer starts Chromium loopback itself.
// Activation success cannot detect that failure, so this is the only path back
// to a working system channel once a call is already running.

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
};

function installDisplayCaptureGlobals(t) {
  installMicCaptureGlobals(t);

  const calls = { getDisplayMedia: 0 };
  const makeTrack = (kind) => ({ kind, readyState: "live", stop() {}, getSettings: () => ({}) });
  navigator.mediaDevices.getDisplayMedia = async () => {
    calls.getDisplayMedia += 1;
    const audio = makeTrack("audio");
    const video = makeTrack("video");
    return {
      getTracks: () => [audio, video],
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
    };
  };
  return calls;
}

function createElectronAPI({ systemAudioMode, systemAudioStrategy }) {
  const listeners = { systemAudioDegraded: null };
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
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
    onMeetingSystemAudioDegraded: (callback) => {
      listeners.systemAudioDegraded = callback;
      return () => {
        if (listeners.systemAudioDegraded === callback) listeners.systemAudioDegraded = null;
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
    cachePrefix: "openwhispr-meeting-system-audio-degraded-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("degrade event starts renderer loopback once for a native Windows session", async (t) => {
  const calls = installDisplayCaptureGlobals(t);
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "wasapi-loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  // Main owns the helper, so the renderer captures nothing up front.
  assert.equal(calls.getDisplayMedia, 0);
  assert.equal(typeof listeners.systemAudioDegraded, "function");

  listeners.systemAudioDegraded();
  await flush();
  assert.equal(calls.getDisplayMedia, 1);

  // A repeat must not stack a second capture graph on the same session.
  listeners.systemAudioDegraded();
  await flush();
  assert.equal(calls.getDisplayMedia, 1);

  await store.stopRecording();
});

test("degrade event is ignored once the recording has stopped", async (t) => {
  const calls = installDisplayCaptureGlobals(t);
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "wasapi-loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  const degraded = listeners.systemAudioDegraded;
  await store.stopRecording();

  degraded();
  await flush();
  assert.equal(calls.getDisplayMedia, 0);
});

test("a renderer-loopback session never registers the takeover listener", async (t) => {
  installDisplayCaptureGlobals(t);
  const { api, listeners } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  // The renderer already owns capture here; there is nothing to take over.
  assert.equal(listeners.systemAudioDegraded, null);

  await store.stopRecording();
});
