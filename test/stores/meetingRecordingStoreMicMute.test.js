const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Muting the mic mid-recording disables its track and keeps the channel on its
// clock with silent frames, so system audio keeps transcribing and main sees
// ordinary silence. A device swap must not unmute, and a new recording starts live.

const START_ARGS = {
  noteId: 4,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: false,
  diarizationEnabled: false,
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeMicStream(label) {
  const listeners = new Map();
  const track = {
    label,
    readyState: "live",
    muted: false,
    enabled: true,
    stop() {
      track.readyState = "ended";
    },
    getSettings: () => ({}),
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    end() {
      track.readyState = "ended";
      listeners.get("ended")?.();
    },
  };
  return {
    track,
    stream: {
      getTracks: () => [track],
      getAudioTracks: () => [track],
      getVideoTracks: () => [],
    },
  };
}

function installMuteHarness(t, { mainStart } = {}) {
  installMicCaptureGlobals(t);
  const mics = [];
  navigator.mediaDevices.getUserMedia = async () => {
    const mic = makeMicStream(`Mic ${mics.length + 1}`);
    mics.push(mic);
    return mic.stream;
  };
  const workletPorts = [];
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
      workletPorts.push(this.port);
    }
    connect() {}
    disconnect() {}
  };

  const sent = [];
  const mutedReports = [];
  const noopListener = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      strategy: "unsupported",
    }),
    meetingTranscriptionStart: async () => {
      await mainStart;
      return {
        success: true,
        systemAudioMode: "unsupported",
        systemAudioStrategy: "unsupported",
      };
    },
    meetingTranscriptionSetMicMuted: async (sessionId, muted) => {
      mutedReports.push({ sessionId, muted });
      return { success: true };
    },
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend: (chunk, source) => sent.push({ chunk, source }),
    onMeetingTranscriptionSegment: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingSystemAudioDegraded: noopListener,
  };
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  return { mics, workletPorts, sent, mutedReports };
}

async function loadStore(t) {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-mic-mute-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const speech = () => new Int16Array([1200, -900, 3000, -2500]).buffer;
const isSilent = (buffer) => new Int16Array(buffer).every((sample) => sample === 0);

test("muting disables the mic track and sends silence in its place", async (t) => {
  const { mics, workletPorts, sent } = installMuteHarness(t);
  const store = await loadStore(t);

  assert.equal(await store.startRecording(START_ARGS), true);
  t.after(() => store.stopRecording());
  const port = workletPorts[0];
  assert.ok(port?.onmessage, "the mic pipeline is connected");

  store.setMicMuted(true);
  assert.equal(mics[0].track.enabled, false);
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, true);

  sent.length = 0;
  port.onmessage({ data: speech() });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].source, "mic");
  assert.equal(sent[0].chunk.byteLength, 8, "the timeline keeps the chunk's length");
  assert.ok(isSilent(sent[0].chunk), "no mic audio leaves the renderer while muted");

  store.setMicMuted(false);
  assert.equal(mics[0].track.enabled, true);
  sent.length = 0;
  port.onmessage({ data: speech() });
  assert.equal(isSilent(sent[0].chunk), false);
});

test("a replacement microphone comes up muted while the recording is muted", async (t) => {
  const { mics } = installMuteHarness(t);
  const store = await loadStore(t);

  await store.startRecording(START_ARGS);
  t.after(() => store.stopRecording());
  store.setMicMuted(true);

  mics[0].track.end();
  for (let i = 0; i < 20 && mics.length < 2; i++) await flush();
  await flush();

  assert.equal(mics.length, 2, "recovery opened a replacement mic");
  assert.equal(mics[1].track.enabled, false);
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, true);
});

test("a new recording starts with the microphone live", async (t) => {
  const { mics } = installMuteHarness(t);
  const store = await loadStore(t);

  // Stale state from any earlier path must not carry into a new recording.
  store.useMeetingRecordingStore.setState({ micMuted: true });
  await store.startRecording(START_ARGS);
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, false);
  assert.equal(mics.at(-1).track.enabled, true);
  store.setMicMuted(true);
  await store.stopRecording();
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, false);

  await store.startRecording(START_ARGS);
  t.after(() => store.stopRecording());
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, false);
  assert.equal(mics.at(-1).track.enabled, true);
});

test("mute does nothing when no recording is running", async (t) => {
  installMuteHarness(t);
  const store = await loadStore(t);

  store.setMicMuted(true);
  assert.equal(store.useMeetingRecordingStore.getState().micMuted, false);
});

test("mute is reported to main so auto-end doesn't read the room as silent", async (t) => {
  const { mutedReports } = installMuteHarness(t);
  const store = await loadStore(t);

  await store.startRecording(START_ARGS);
  t.after(() => store.stopRecording());
  const sessionId = store.getActiveRecordingSessionId();
  store.setMicMuted(true);
  store.setMicMuted(false);

  assert.deepEqual(mutedReports, [
    { sessionId, muted: true },
    { sessionId, muted: false },
  ]);
});

test("speech buffered while main connects stays behind when muted before it is sent", async (t) => {
  const connect = Promise.withResolvers();
  const { workletPorts, sent, mutedReports } = installMuteHarness(t, {
    mainStart: connect.promise,
  });
  const store = await loadStore(t);

  const starting = store.startRecording(START_ARGS);
  for (let i = 0; i < 20 && !workletPorts[0]?.onmessage; i++) await flush();
  workletPorts[0].onmessage({ data: speech() });
  store.setMicMuted(true);
  connect.resolve();
  await starting;
  t.after(() => store.stopRecording());

  const mic = sent.filter((entry) => entry.source === "mic");
  assert.equal(mic.length, 1);
  assert.ok(isSilent(mic[0].chunk));
  assert.ok(
    mutedReports.some((report) => report.muted && report.sessionId),
    "the mute is resent once the session is live"
  );
});
