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
const LOOPBACK = { mode: "loopback", strategy: "loopback", status: "granted", granted: true };

async function pendingStartup(t, { prewarm = false, loopback = false } = {}) {
  const ready = Promise.withResolvers();
  const requested = Promise.withResolvers();
  const captured = Promise.withResolvers();
  const availabilityRequested = Promise.withResolvers();
  const availability = Promise.withResolvers();
  const sent = [];
  const sources = [];
  const capturedAt = [];
  const worklets = [];
  let stoppedTracks = 0;
  let closedContexts = 0;
  let mainStarts = 0;
  let mainStops = 0;
  const noop = () => () => {};
  const api = {
    checkSystemAudioAccess: async () =>
      loopback
        ? LOOPBACK
        : { mode: "unsupported", strategy: "unsupported", status: "unsupported", granted: false },
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
    meetingTranscriptionSetSystemAudioAvailable: () => {
      availabilityRequested.resolve();
      return loopback ? availability.promise : Promise.resolve({ success: true });
    },
    meetingTranscriptionSend: (buffer, source, at) => {
      sent.push([...new Int16Array(buffer)]);
      sources.push(source);
      capturedAt.push(at);
    },
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
  navigator.mediaDevices.getDisplayMedia = async (...args) => acquire(...args);
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
    availability.resolve({ success: true });
    await Promise.all([preparing, starting]);
    await store.stopRecording();
  });
  await Promise.all([requested.promise, captured.promise]);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    store,
    api,
    sent,
    sources,
    capturedAt,
    starting,
    ready,
    availabilityRequested: availabilityRequested.promise,
    availability,
    finish: async (result = CONNECTED) => {
      ready.resolve(result);
      await Promise.all([preparing, starting]);
    },
    speak: (samples) => worklets[0]?.port.onmessage?.({ data: new Int16Array(samples).buffer }),
    speakSystem: (samples) =>
      worklets.at(-1)?.port.onmessage?.({ data: new Int16Array(samples).buffer }),
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

test("buffered startup speech tells main when it was captured; live speech does not", async (t) => {
  const session = await pendingStartup(t);
  const before = Date.now();
  session.speak([1234, -4567]);
  const after = Date.now();
  await session.finish();
  session.speak([333, 444]);
  assert.equal(session.capturedAt.length, 2);
  assert.ok(session.capturedAt[0] >= before && session.capturedAt[0] <= after);
  assert.equal(session.capturedAt[1], undefined);
  await session.store.stopRecording();
});

test("buffered system audio tells main when it was captured, like buffered mic audio", async (t) => {
  const session = await pendingStartup(t, { loopback: true });
  session.ready.resolve({
    ...CONNECTED,
    systemAudioMode: "loopback",
    systemAudioStrategy: "loopback",
  });
  // Main confirms system audio before the renderer marks its socket ready.
  await session.availabilityRequested;
  const before = Date.now();
  session.speakSystem([5, 6]);
  const after = Date.now();
  assert.deepEqual(session.sent, [], "System audio must wait for the authenticated connection");

  session.availability.resolve({ success: true });
  await session.starting;
  session.speakSystem([7, 8]);
  assert.deepEqual(session.sources, ["system", "system"]);
  assert.deepEqual(session.sent, [
    [5, 6],
    [7, 8],
  ]);
  assert.ok(session.capturedAt[0] >= before && session.capturedAt[0] <= after);
  assert.equal(session.capturedAt[1], undefined);
  await session.store.stopRecording();
});

test("stopping during a slow connect releases the microphone before main settles", async (t) => {
  const session = await pendingStartup(t);
  const stopping = session.store.stopRecording();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.resources().stoppedTracks, 1, "the mic is off while main still connects");
  await session.finish();
  await stopping;
  assert.deepEqual(session.resources(), {
    stoppedTracks: 1,
    closedContexts: 1,
    mainStarts: 1,
    mainStops: 1,
  });
});
