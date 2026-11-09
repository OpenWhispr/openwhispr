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

for (const unresolvedPolicy of [false, true]) {
  test(`automatic start revoked during access checks never opens capture (unresolved: ${unresolvedPolicy})`, async (t) => {
    const checking = Promise.withResolvers();
    const access = Promise.withResolvers();
    let allowed = true;
    let captures = 0;
    installMicCaptureGlobals(t);
    navigator.mediaDevices.getUserMedia = async () => {
      captures++;
      throw new Error("unexpected capture");
    };
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          checkSystemAudioAccess: () => {
            checking.resolve();
            return access.promise;
          },
          meetingTranscriptionStart: async () => {
            captures++;
            throw new Error("unexpected start");
          },
        },
      },
    });
    const vite = await createRendererServer(t, { cachePrefix: "meeting-auto-start-revoked-" });
    const { startRecording, useMeetingRecordingStore } = await vite.ssrLoadModule(
      "/stores/meetingRecordingStore.ts"
    );
    const starting = startRecording({
      ...START_ARGS,
      noteId: 7,
      noteTitle: "Standup",
      folderId: 3,
      seedSegments: [{ id: "earlier", text: "Earlier", source: "mic", timestamp: 1 }],
      canAutoStart: () => allowed,
    });
    await checking.promise;
    allowed = false;
    if (unresolvedPolicy) {
      const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
      usePolicyStore.setState({ status: "loading", policy: null });
    }
    access.resolve({
      mode: "unsupported",
      strategy: "unsupported",
      status: "unsupported",
      granted: false,
    });
    assert.equal(await starting, false);
    assert.equal(await startRecording({ ...START_ARGS, canAutoStart: () => false }), false);
    assert.equal(captures, 0);
    const state = useMeetingRecordingStore.getState();
    assert.equal(state.isRecording, false);
    assert.equal(state.error, null);
    assert.equal(state.recordingNoteId, null, "a start that never captured owns no note");
    assert.equal(state.recordingNoteTitle, null);
    assert.equal(state.recordingFolderId, null);
    assert.equal(state.recordingStartedAt, null);
    assert.deepEqual(state.segments, []);
    assert.equal(state.transcript, "");
  });
}

async function pendingStartup(
  t,
  { prewarm = false, loopback = false, canAutoStart, onDisplayRequest } = {}
) {
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
  navigator.mediaDevices.getDisplayMedia = async (...args) => {
    onDisplayRequest?.();
    return acquire(...args);
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
  const starting = store.startRecording({ ...START_ARGS, canAutoStart });
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

test("automatic consent stays live while both prewarm and microphone selection are pending", async (t) => {
  const ready = Promise.withResolvers();
  const selecting = Promise.withResolvers();
  const selected = Promise.withResolvers();
  let allowed = true;
  const captures = [];
  installMicCaptureGlobals(t);
  navigator.mediaDevices.getUserMedia = async () => {
    captures.push("mic");
    throw new Error("unexpected microphone capture");
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: () => ready.promise,
        meetingTranscriptionStart: async () => {
          captures.push("main");
          return CONNECTED;
        },
        checkSystemAudioAccess: async () => ({
          mode: "unsupported",
          strategy: "unsupported",
          status: "unsupported",
          granted: false,
        }),
        meetingTranscriptionStop: async () => ({ success: true }),
      },
    },
  });
  globalThis.__meetingMicrophoneSelection = () => {
    selecting.resolve();
    return selected.promise;
  };
  t.after(() => delete globalThis.__meetingMicrophoneSelection);
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-pending-auto-consent-",
    mockModules: {
      "../helpers/microphoneSelection":
        "export const resolvePreferredMicrophone = () => globalThis.__meetingMicrophoneSelection();",
    },
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const preparing = store.prepareTranscription();
  const starting = store.startRecording({ ...START_ARGS, canAutoStart: () => allowed });
  await selecting.promise;
  allowed = false;
  ready.resolve({ success: true });
  selected.resolve({ device: null });
  await preparing;
  assert.equal(await starting, false);
  assert.deepEqual(captures, []);
  assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
  assert.equal(store.useMeetingRecordingStore.getState().error, null);
});

for (const nativeCapture of [false, true]) {
  test(`automatic main setup ${nativeCapture ? "with" : "without"} native capture waits for microphone selection`, async (t) => {
    const selecting = Promise.withResolvers();
    const devices = Promise.withResolvers();
    let store;
    let starting;
    t.after(async () => {
      devices.resolve([]);
      await starting;
      await store?.stopRecording();
    });
    let allowed = true;
    let microphoneCalls = 0;
    let mainStarts = 0;
    let mainStops = 0;
    installMicCaptureGlobals(t);
    const acquire = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.enumerateDevices = () => {
      selecting.resolve();
      return devices.promise;
    };
    navigator.mediaDevices.getUserMedia = async (...args) => {
      microphoneCalls++;
      return acquire(...args);
    };
    const strategy = nativeCapture ? "native" : "unsupported";
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          checkSystemAudioAccess: async () => ({
            mode: strategy,
            strategy,
            status: nativeCapture ? "granted" : "unsupported",
            granted: nativeCapture,
          }),
          meetingTranscriptionStart: async () => {
            mainStarts++;
            return { success: true, systemAudioMode: strategy, systemAudioStrategy: strategy };
          },
          meetingTranscriptionStop: async () => {
            mainStops++;
            return { success: true };
          },
        },
      },
    });
    const vite = await createRendererServer(t, { cachePrefix: "meeting-main-capture-consent-" });
    store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
    starting = store.startRecording({ ...START_ARGS, canAutoStart: () => allowed });
    await selecting.promise;
    assert.equal(mainStarts, 0, "main setup cannot consume the note session before capture");
    allowed = false;
    devices.resolve([]);
    assert.equal(await starting, false);
    assert.equal(microphoneCalls, 0);
    assert.equal(mainStarts, 0);
    assert.equal(mainStops, 0);
    assert.equal(store.useMeetingRecordingStore.getState().isRecording, false);
    assert.equal(store.useMeetingRecordingStore.getState().error, null);
  });
}

for (const automatic of [false, true]) {
  for (const microphoneFails of [false, true]) {
    test(`${automatic ? "automatic" : "explicit"} native startup preserves capture ordering and continuity (microphone fails: ${microphoneFails})`, async (t) => {
      const connecting = Promise.withResolvers();
      const connected = Promise.withResolvers();
      const requestedMicrophone = Promise.withResolvers();
      const calls = [];
      let allowed = true;
      let store;
      let starting;
      t.after(async () => {
        connected.resolve({
          success: true,
          systemAudioMode: "native",
          systemAudioStrategy: "native",
        });
        await starting;
        await store?.stopRecording();
      });
      installMicCaptureGlobals(t);
      const acquire = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async (...args) => {
        calls.push("mic");
        requestedMicrophone.resolve();
        if (microphoneFails) throw new Error("Microphone unavailable");
        return acquire(...args);
      };
      installBrowserGlobals(t, {
        window: {
          electronAPI: {
            checkSystemAudioAccess: async () => ({
              mode: "native",
              strategy: "native",
              status: "granted",
              granted: true,
            }),
            meetingTranscriptionStart: () => {
              calls.push("main");
              connecting.resolve();
              return connected.promise;
            },
            meetingTranscriptionStop: async () => ({ success: true }),
          },
        },
      });
      const vite = await createRendererServer(t, { cachePrefix: "meeting-native-start-order-" });
      store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
      starting = store.startRecording({
        ...START_ARGS,
        canAutoStart: automatic ? () => allowed : undefined,
      });
      await Promise.all([connecting.promise, requestedMicrophone.promise]);
      assert.deepEqual(calls, automatic ? ["mic", "main"] : ["main", "mic"]);
      allowed = false;
      connected.resolve({
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "native",
      });
      assert.equal(
        await starting,
        true,
        "a policy flip after the first capture request keeps the recording"
      );
      assert.equal(store.useMeetingRecordingStore.getState().isRecording, true);
    });
  }
}

test("policy changes after capture begins do not interrupt pending connection or live audio", async (t) => {
  let allowed = true;
  const session = await pendingStartup(t, { prewarm: true, canAutoStart: () => allowed });
  allowed = false;
  session.speak([100, 200]);
  await session.finish();
  session.speak([300, 400]);
  assert.equal(await session.starting, true);
  assert.equal(session.store.useMeetingRecordingStore.getState().isRecording, true);
  assert.deepEqual(session.sent, [
    [100, 200],
    [300, 400],
  ]);
  await session.store.stopRecording();
});

test("display capture latches consent while the prewarm still holds main's start", async (t) => {
  let allowed = true;
  const session = await pendingStartup(t, {
    prewarm: true,
    loopback: true,
    canAutoStart: () => allowed,
    onDisplayRequest: () => (allowed = false),
  });
  session.availability.resolve({ success: true });
  await session.finish();
  assert.equal(await session.starting, true);
  assert.equal(session.store.useMeetingRecordingStore.getState().isRecording, true);
  await session.store.stopRecording();
});

test("consent lost before capture preparation never shows a recording state", async (t) => {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, { cachePrefix: "meeting-auto-no-flash-" });
  const { startRecording, useMeetingRecordingStore } = await vite.ssrLoadModule(
    "/stores/meetingRecordingStore.ts"
  );
  const states = [];
  const unsubscribe = useMeetingRecordingStore.subscribe((state) => states.push(state.isRecording));
  t.after(unsubscribe);
  let checks = 0;
  const started = await startRecording({
    ...START_ARGS,
    // Allowed at the first check, gone by the second, past the previous recording's stop.
    canAutoStart: () => (checks += 1) === 1,
  });
  assert.equal(started, false);
  assert.equal(states.includes(true), false);
});
