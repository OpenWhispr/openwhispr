const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { deferred } = require("./harness/deferred");

const settings = {
  useLocalWhisper: false,
  cloudTranscriptionMode: "openwhispr",
  isSignedIn: true,
  useCleanupModel: false,
  toneStyleEnabled: false,
};

// The real start and cancel paths with the devices stubbed, and a provider whose
// start stays pending until the test settles it.
async function load(t, { providerName = "orukeet", stopAbortsStart = true } = {}) {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: `orukeet-start-cancel-${providerName}-${stopAbortsStart}-`,
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState(settings);
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = {};
    }
  };
  t.after(() => delete globalThis.AudioWorkletNode);

  const audioNode = { connect() {} };
  const connect = deferred();
  const calls = { starts: 0, stops: 0, limitPrompts: 0, errors: 0, states: [], sent: [] };
  window.electronAPI.notifyLimitReached = () => calls.limitPrompts++;
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    sttConfig: {},
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
    _streamingStopPromise: null,
    _streamingStopMode: null,
    workletModuleLoaded: true,
    preparedMicCapture: { take: async () => null },
    micRecovery: { stop() {} },
    isRecordingAllowedByPolicy: () => true,
    _beginActivationCapture: async () => true,
    getAudioConstraints: async () => ({}),
    _acquireCaptureStream: async () => ({ getAudioTracks: () => [] }),
    _startRecordingSpool: () => null,
    startStreamingFallbackRecorder() {},
    getOrCreateAudioContext: async () => ({
      createMediaStreamSource: () => audioNode,
      createAnalyser: () => audioNode,
    }),
    getStreamingProviderName: () => providerName,
    getStreamingProvider: () => ({
      onPartial: () => () => {},
      onFinal: () => () => {},
      onError: () => () => {},
      onSessionEnd: () => () => {},
      send: (frame) => calls.sent.push(frame),
      start: () => {
        calls.starts++;
        return connect.promise;
      },
      stop: async () => {
        calls.stops++;
        if (stopAbortsStart) connect.resolve({ success: false, error: "cancelled" });
        return { success: true };
      },
    }),
    beginMicRecovery: async () => {},
    getEffectiveSttLanguage: () => "en",
    getKeyterms: () => [],
    getPipelineCleanupOptions: () => undefined,
    cleanupStreaming: async () => {},
    cleanupStreamingAudio() {},
    cleanupStreamingListeners() {},
    cleanupPreview: async () => null,
    onError: () => calls.errors++,
    onStateChange: (state) => calls.states.push(state),
  });
  manager._requestStreamingCancellation = () => {
    manager._streamingCancellationGeneration += 1;
  };
  return { manager, connect, calls, vite };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a streaming start reports recording before its provider connect finishes", async (t) => {
  const { manager, connect, calls } = await load(t);
  const starting = manager.startStreamingRecording();
  await tick();
  assert.equal(calls.starts, 1);
  assert.deepEqual(calls.states.at(-1), {
    isRecording: true,
    isProcessing: false,
    isStreaming: true,
  });
  connect.resolve({ success: true });
  assert.equal(await starting, true);
});

test("cancelling managed Orukeet's pending connect aborts it instead of waiting it out", async (t) => {
  const { manager, calls } = await load(t);
  const starting = manager.startStreamingRecording();
  await tick();

  // Nothing but the stop settles the connect, so a cancel that waits for it hangs.
  const cancelling = manager.cancelStreamingRecording();
  assert.deepEqual(await Promise.all([starting, cancelling]), [false, true]);
  assert.ok(calls.stops >= 1);
  assert.equal(calls.errors, 0);
  assert.equal(manager.streamingStartInProgress, false);
  assert.deepEqual(calls.states.at(-1), {
    isRecording: false,
    isProcessing: false,
    isStreaming: false,
  });
});

test("cancelling another provider's pending connect still waits for it to settle", async (t) => {
  const { manager, connect, calls } = await load(t, {
    providerName: "openai-realtime",
    stopAbortsStart: false,
  });
  const starting = manager.startStreamingRecording();
  await tick();

  const cancelling = manager.cancelStreamingRecording();
  await tick();
  assert.equal(calls.stops, 0);

  connect.resolve({ success: true });
  assert.deepEqual(await Promise.all([starting, cancelling]), [false, true]);
  assert.equal(calls.stops, 1);
});

test("a cancel before the connect begins opens no session", async (t) => {
  const { manager, calls } = await load(t);
  const micRecovery = deferred();
  manager.beginMicRecovery = () => micRecovery.promise;
  const starting = manager.startStreamingRecording();
  await tick();
  assert.equal(calls.starts, 0);

  const cancelling = manager.cancelStreamingRecording();
  micRecovery.resolve();
  assert.deepEqual(await Promise.all([starting, cancelling]), [false, true]);
  assert.equal(calls.starts, 0);
});

const LIMIT_REACHED = {
  success: false,
  code: "LIMIT_REACHED",
  error: "Weekly word limit reached",
  details: { wordsUsed: 2000, limit: 2000 },
};

test("a limit answer that lands after the cancel opens no upgrade prompt", async (t) => {
  const { manager, connect, calls } = await load(t, {
    providerName: "openai-realtime",
    stopAbortsStart: false,
  });
  const starting = manager.startStreamingRecording();
  await tick();

  const cancelling = manager.cancelStreamingRecording();
  connect.resolve(LIMIT_REACHED);
  assert.deepEqual(await Promise.all([starting, cancelling]), [false, true]);
  assert.equal(calls.limitPrompts, 0);
  assert.equal(calls.errors, 0);
});

test("a limit answer with no cancel still opens the upgrade prompt", async (t) => {
  const { manager, connect, calls } = await load(t);
  const starting = manager.startStreamingRecording();
  await tick();

  connect.resolve(LIMIT_REACHED);
  assert.equal(await starting, false);
  assert.equal(calls.limitPrompts, 1);
  assert.equal(calls.errors, 1);
});

const speak = (manager, ...frames) => {
  for (const frame of frames) manager.streamingProcessor.port.onmessage({ data: frame });
};
const pcmFrame = () => new Int16Array(160).buffer;

test("managed Orukeet holds audio until its session has started, in order", async (t) => {
  const { manager, connect, calls } = await load(t);
  const starting = manager.startStreamingRecording();
  await tick();

  const [first, second, third] = [pcmFrame(), pcmFrame(), pcmFrame()];
  speak(manager, first, second);
  assert.deepEqual(calls.sent, []);

  connect.resolve({ success: true });
  assert.equal(await starting, true);
  speak(manager, third);
  assert.equal(calls.sent.length, 3);
  assert.equal(calls.sent[0], first);
  assert.equal(calls.sent[1], second);
  assert.equal(calls.sent[2], third);
});

test("managed Orukeet holds audio from before recording is reported", async (t) => {
  const { manager, connect, calls } = await load(t);
  const early = pcmFrame();
  const reportRecording = manager.onStateChange;
  manager.onStateChange = (state) => {
    speak(manager, early);
    reportRecording(state);
  };
  const starting = manager.startStreamingRecording();
  await tick();
  assert.deepEqual(calls.sent, []);

  connect.resolve({ success: true });
  assert.equal(await starting, true);
  assert.equal(calls.sent[0], early);
});

test("managed Orukeet keeps the audio it held through a session retry", async (t) => {
  const { manager, calls, vite } = await load(t);
  (await vite.ssrLoadModule("/lib/auth.ts")).updateLastSignInTime();
  const frames = [pcmFrame(), pcmFrame()];
  const answers = [
    { success: false, code: "AUTH_EXPIRED", error: "Session expired" },
    { success: true },
  ];
  const provider = manager.getStreamingProvider();
  manager.getStreamingProvider = () => ({
    ...provider,
    start: async () => {
      speak(manager, frames[calls.starts++]);
      return answers.shift();
    },
  });

  assert.equal(await manager.startStreamingRecording(), true);
  assert.equal(calls.starts, 2);
  assert.equal(calls.sent.length, 2);
  assert.equal(calls.sent[0], frames[0]);
  assert.equal(calls.sent[1], frames[1]);
});

test("Tone & Style's wait keeps the audio managed Orukeet already held", async (t) => {
  const { manager, connect, calls, vite } = await load(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({ toneStyleEnabled: true });
  Object.assign(manager, {
    getPipelineCleanupOptions: () => ({}),
    toneStylePromise: Promise.resolve("email"),
    toneStyleStartDeadline: 0,
  });
  const early = pcmFrame();
  const reportRecording = manager.onStateChange;
  manager.onStateChange = (state) => {
    speak(manager, early);
    reportRecording(state);
  };

  connect.resolve({ success: true });
  assert.equal(await manager.startStreamingRecording(), true);
  assert.equal(manager.lastToneAppCategory, "email");
  assert.equal(calls.sent[0], early);
});

test("a managed Orukeet start that fails over sends none of the audio it held", async (t) => {
  const { manager, connect, calls } = await load(t);
  manager.startStreamingFallbackRecorder = () => {
    manager.streamingFallbackRecorder = {};
  };
  const starting = manager.startStreamingRecording();
  await tick();
  speak(manager, pcmFrame());

  connect.resolve({ success: false, error: "refused" });
  assert.equal(await starting, true);
  speak(manager, pcmFrame());
  assert.deepEqual(calls.sent, []);
});

test("another provider's audio still goes to main as it is captured", async (t) => {
  const { manager, connect, calls } = await load(t, { providerName: "openai-realtime" });
  const starting = manager.startStreamingRecording();
  await tick();

  const frame = pcmFrame();
  speak(manager, frame);
  assert.equal(calls.sent[0], frame);
  connect.resolve({ success: true });
  assert.equal(await starting, true);
  assert.equal(calls.sent.length, 1);
});
