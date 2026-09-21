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

function installDisplayCaptureGlobals(t, { capture = null } = {}) {
  installMicCaptureGlobals(t);

  const calls = { getDisplayMedia: 0 };
  const makeTrack = (kind) => ({ kind, readyState: "live", stop() {}, getSettings: () => ({}) });
  navigator.mediaDevices.getDisplayMedia = async () => {
    calls.getDisplayMedia += 1;
    if (capture) return capture.promise;
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

// The takeover builds its own AudioContext, so swapping the global once the
// recording is running leaves the mic graph alone. Loading the worklet module
// is the await a stop lands in, because cleanup closes the context underneath.
function installFailingSystemAudioContext(addModule) {
  const Base = globalThis.AudioContext;
  globalThis.AudioContext = class extends Base {
    constructor(...args) {
      super(...args);
      this.audioWorklet = { addModule };
    }
  };
}

function createElectronAPI({ systemAudioMode, systemAudioStrategy }) {
  const listeners = { systemAudioDegraded: null };
  const systemAudioAvailability = [];
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
    meetingTranscriptionSetSystemAudioAvailable: async (_sessionId, available) => {
      systemAudioAvailability.push(available);
      return { success: true };
    },
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
  return { api, listeners, systemAudioAvailability };
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

test("a failed takeover warns and gives up the session's system channel", async (t) => {
  const capture = Promise.withResolvers();
  installDisplayCaptureGlobals(t, { capture });
  const { api, listeners, systemAudioAvailability } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "wasapi-loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.systemAudioDegraded();
  capture.reject(new Error("Permission denied by system"));
  await flush();

  // Nothing captures the call now, so the interruption is the only warning the
  // user gets, and auto-end must stop counting on a system channel.
  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "loopback_takeover_failed",
  });
  assert.deepEqual(systemAudioAvailability, [true, false]);

  await store.stopRecording();
});

test("a takeover that fails after the recording stopped touches nothing", async (t) => {
  const capture = Promise.withResolvers();
  installDisplayCaptureGlobals(t, { capture });
  const { api, listeners, systemAudioAvailability } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "wasapi-loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.systemAudioDegraded();
  await store.stopRecording();
  capture.reject(new Error("Permission denied by system"));
  await flush();

  // Both writes below are shared with the next recording: a warning it would
  // deliver as its own, and the system-audio state auto-end reads.
  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.deepEqual(systemAudioAvailability, [true]);
});

test("a takeover whose capture graph throws gives up the same way", async (t) => {
  installDisplayCaptureGlobals(t);
  const { api, listeners, systemAudioAvailability } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "wasapi-loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  installFailingSystemAudioContext(async () => {
    throw new Error("AudioWorklet module failed to load");
  });
  listeners.systemAudioDegraded();
  await flush();

  // A stream that arrives but cannot be wired up leaves the call just as
  // uncaptured as one that never arrived, so it must warn just as loudly.
  assert.deepEqual(store.useMeetingRecordingStore.getState().systemAudioInterrupted, {
    recovering: false,
    reason: "loopback_takeover_failed",
  });
  assert.deepEqual(systemAudioAvailability, [true, false]);

  await store.stopRecording();
});

test("a capture graph that throws after the recording stopped touches nothing", async (t) => {
  const attach = Promise.withResolvers();
  installDisplayCaptureGlobals(t);
  const { api, listeners, systemAudioAvailability } = createElectronAPI({
    systemAudioMode: "loopback",
    systemAudioStrategy: "wasapi-loopback",
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  installFailingSystemAudioContext(() => attach.promise);
  listeners.systemAudioDegraded();
  await flush();
  await store.stopRecording();
  attach.reject(new Error("Cannot add module to a closed AudioContext"));
  await flush();

  assert.equal(store.useMeetingRecordingStore.getState().systemAudioInterrupted, null);
  assert.deepEqual(systemAudioAvailability, [true]);
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
