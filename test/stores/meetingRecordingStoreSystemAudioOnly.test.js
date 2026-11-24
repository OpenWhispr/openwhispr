const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// A system-audio-only recording (lectures, videos, podcasts) never opens the
// microphone: no permission prompt, no mic-in-use indicator, and no "microphone
// failed" warning for a mic that was never asked for.

const START_ARGS = {
  noteId: 9,
  noteTitle: "Lecture",
  folderId: null,
  autoEndEligible: false,
  diarizationEnabled: false,
};

const NATIVE = { systemAudioMode: "loopback", systemAudioStrategy: "wasapi-loopback" };
const UNSUPPORTED = { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };

function installHarness(t, { systemAudioMode, systemAudioStrategy }) {
  installMicCaptureGlobals(t);
  const calls = { getUserMedia: 0, mainStarts: 0 };
  const realGetUserMedia = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async (...args) => {
    calls.getUserMedia += 1;
    return realGetUserMedia(...args);
  };
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: systemAudioMode !== "unsupported",
      status: systemAudioMode === "unsupported" ? "unsupported" : "granted",
      mode: systemAudioMode,
      strategy: systemAudioStrategy,
    }),
    meetingTranscriptionStart: async () => {
      calls.mainStarts += 1;
      return { success: true, systemAudioMode, systemAudioStrategy };
    },
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
    onMeetingSystemAudioDegraded: noopListener,
    onMeetingSystemAudioInterrupted: noopListener,
    onMeetingSystemAudioResumed: noopListener,
  };
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  return calls;
}

async function loadStore(t) {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-system-audio-only-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

test("a system-audio-only recording never opens the microphone", async (t) => {
  const calls = installHarness(t, NATIVE);
  const store = await loadStore(t);

  assert.equal(await store.startRecording({ ...START_ARGS, audioSource: "system" }), true);
  t.after(() => store.stopRecording());

  const state = store.useMeetingRecordingStore.getState();
  assert.equal(calls.getUserMedia, 0);
  assert.equal(calls.mainStarts, 1);
  assert.equal(state.isRecording, true);
  assert.equal(state.recordingAudioSource, "system");
  assert.equal(state.error, null, "no warning about a mic that was never requested");
  assert.equal(state.micCaptureStatus, "inactive");
});

test("mute has nothing to mute in a system-audio-only recording", async (t) => {
  installHarness(t, NATIVE);
  const store = await loadStore(t);

  await store.startRecording({ ...START_ARGS, audioSource: "system" });
  t.after(() => store.stopRecording());
  store.setMicMuted(true);
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, false);
});

test("a system-audio-only start fails cleanly where system audio is unsupported", async (t) => {
  const calls = installHarness(t, UNSUPPORTED);
  const store = await loadStore(t);

  await store.startRecording({ ...START_ARGS, audioSource: "system" });

  const state = store.useMeetingRecordingStore.getState();
  assert.equal(calls.getUserMedia, 0);
  assert.equal(calls.mainStarts, 0, "nothing connects for a recording that cannot capture");
  assert.equal(state.isRecording, false);
  assert.equal(state.error, "systemAudioOnlyUnavailable");
});

test("the default start still records the microphone and resets the source after", async (t) => {
  const calls = installHarness(t, NATIVE);
  const store = await loadStore(t);

  await store.startRecording({ ...START_ARGS, audioSource: "system" });
  await store.stopRecording();
  assert.equal(store.useMeetingRecordingStore.getState().recordingAudioSource, "both");

  await store.startRecording(START_ARGS);
  t.after(() => store.stopRecording());
  assert.equal(calls.getUserMedia, 1);
  assert.equal(store.useMeetingRecordingStore.getState().recordingAudioSource, "both");
});
