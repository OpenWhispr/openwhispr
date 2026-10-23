const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
  diarizationEnabled: false,
};
const CONNECTED = {
  success: true,
  systemAudioMode: "unsupported",
  systemAudioStrategy: "unsupported",
};

async function pendingStartup(t, { prewarm = false } = {}) {
  const ready = Promise.withResolvers();
  const requested = Promise.withResolvers();
  const captured = Promise.withResolvers();
  const sent = [];
  const worklets = [];
  let stoppedTracks = 0;
  let closedContexts = 0;
  let mainStarts = 0;
  let mainStops = 0;
  const noop = () => () => {};
  const api = {
    checkSystemAudioAccess: async () => ({
      mode: "unsupported",
      strategy: "unsupported",
      status: "unsupported",
      granted: false,
    }),
    meetingTranscriptionPrepare: () => {
      requested.resolve();
      return ready.promise;
    },
    meetingTranscriptionStart: () => {
      mainStarts += 1;
      requested.resolve();
      return prewarm ? Promise.resolve(CONNECTED) : ready.promise;
    },
    meetingTranscriptionStop: async () => {
      mainStops += 1;
      return { success: true };
    },
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionSend: (buffer) => sent.push([...new Int16Array(buffer)]),
    onMeetingTranscriptionSegment: noop,
    onMeetingSpeakerIdentified: noop,
    onMeetingSpeakersMerged: noop,
    onMeetingSessionSpeakerConfigUpdated: noop,
    onMeetingTranscriptionError: noop,
    onMeetingTranscriptionFatalError: noop,
    onMeetingSystemAudioSilent: noop,
    onMeetingSystemAudioInterrupted: noop,
    onMeetingSystemAudioResumed: noop,
  };
  installMicCaptureGlobals(t);
  const acquire = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await acquire(...args);
    for (const track of stream.getTracks()) track.stop = () => (stoppedTracks += 1);
    captured.resolve();
    return stream;
  };
  const Context = global.AudioContext;
  global.AudioContext = class extends Context {
    async close() {
      closedContexts += 1;
    }
  };
  const Worklet = global.AudioWorkletNode;
  global.AudioWorkletNode = class extends Worklet {
    constructor(...args) {
      super(...args);
      worklets.push(this);
    }
  };
  installBrowserGlobals(t, { window: { electronAPI: api, setTimeout } });
  const vite = await createRendererServer(t, { cachePrefix: "ow-meeting-startup-audio-" });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const preparing = prewarm ? store.prepareTranscription() : Promise.resolve();
  const starting = store.startRecording(START_ARGS);
  t.after(async () => {
    ready.resolve(CONNECTED);
    await Promise.all([preparing, starting]);
    await store.stopRecording();
  });
  await Promise.all([requested.promise, captured.promise]);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    store,
    api,
    sent,
    starting,
    finish: async (result = CONNECTED) => {
      ready.resolve(result);
      await Promise.all([preparing, starting]);
    },
    speak: (samples) => worklets[0]?.port.onmessage?.({ data: new Int16Array(samples).buffer }),
    resources: () => ({ stoppedTracks, closedContexts, mainStarts, mainStops }),
  };
}

for (const prewarm of [false, true]) {
  test(`microphone speech during ${prewarm ? "prewarming" : "cloud connection"} is delivered after startup`, async (t) => {
    const session = await pendingStartup(t, { prewarm });
    session.speak([1234, -4567]);
    session.speak([111, 222]);
    assert.deepEqual(session.sent, [], "Audio must wait for the authenticated connection");
    if (prewarm) assert.equal(session.resources().mainStarts, 0);

    await session.finish();
    session.speak([333, 444]);
    assert.deepEqual(session.sent, [
      [1234, -4567],
      [111, 222],
      [333, 444],
    ]);
    await session.store.stopRecording();
    assert.deepEqual(session.resources(), {
      stoppedTracks: 1,
      closedContexts: 1,
      mainStarts: 1,
      mainStops: 1,
    });
  });
}

test("failed cloud startup discards captured speech and releases the microphone", async (t) => {
  const session = await pendingStartup(t);
  session.speak([1234, -4567]);
  await session.finish({ success: false, error: "Connection failed" });
  assert.deepEqual(session.sent, []);
  assert.equal(session.store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(session.resources().stoppedTracks, 1);
  assert.equal(session.resources().closedContexts, 1);

  session.api.meetingTranscriptionStart = async () => CONNECTED;
  await session.store.startRecording(START_ARGS);
  assert.deepEqual(
    session.sent,
    [],
    "A new recording must not receive an earlier recording's audio"
  );
  await session.store.stopRecording();
});

test("stopping during cloud startup discards captured speech and releases the microphone", async (t) => {
  const session = await pendingStartup(t);
  session.speak([1234, -4567]);
  const stopping = session.store.stopRecording();
  await session.finish();
  await stopping;
  assert.deepEqual(session.sent, []);
  assert.equal(session.store.useMeetingRecordingStore.getState().isRecording, false);
  assert.deepEqual(session.resources(), {
    stoppedTracks: 1,
    closedContexts: 1,
    mainStarts: 1,
    mainStops: 1,
  });
});
