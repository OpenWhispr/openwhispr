const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const good = {
  useLocalWhisper: false,
  cloudTranscriptionMode: "openwhispr",
  isSignedIn: true,
  useCleanupModel: true,
  cleanupMode: "openwhispr",
  cleanupCloudMode: "openwhispr",
  customPrompts: { cleanup: "Keep product names exactly." },
  customDictionary: ["Orukeet"],
  uiLanguage: "en",
  preferredLanguage: "en",
  toneStyleEnabled: false,
  toneStyles: { personal: "very_casual", work: "casual", email: "excited", other: "formal" },
};

async function load(t, cachePrefix) {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/utils/logger":
        "export default { debug() {}, info() {}, warn() {}, error() {}, logReasoning() {} };",
    },
  });
  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const createManager = (fields) =>
    Object.assign(Object.create(AudioManager.prototype), {
      sttConfig: { orukeetPipeline: "gemma12" },
      getCleanupLanguage: () => "en",
      ...fields,
    });
  return { window, useSettingsStore, usePolicyStore, createManager };
}

test("combined cleanup options honor every eligibility guard and use the actual prompt/dictionary", async (t) => {
  const { window, useSettingsStore, usePolicyStore, createManager } = await load(
    t,
    "orukeet-pipeline-guards-"
  );
  const manager = createManager();
  useSettingsStore.setState(good);
  assert.deepEqual(manager.getPipelineCleanupOptions(useSettingsStore.getState()), {
    agentName: "OpenWhispr",
    customDictionary: ["Orukeet"],
    customPrompt: good.customPrompts.cleanup,
    language: "en",
    locale: "en",
  });
  // Tone & Style: the tone picked for the app being dictated into.
  useSettingsStore.setState({ ...good, toneStyleEnabled: true });
  assert.deepEqual(
    manager.getPipelineCleanupOptions(useSettingsStore.getState(), { appCategory: "email" }),
    {
      agentName: "OpenWhispr",
      customDictionary: ["Orukeet"],
      customPrompt: good.customPrompts.cleanup,
      tone: "excited",
      appCategory: "email",
      language: "en",
      locale: "en",
    }
  );
  const blocked = [
    { settings: { useLocalWhisper: true } },
    { settings: { cloudTranscriptionMode: "byok" } },
    { settings: { useCleanupModel: false } },
    { settings: { cleanupMode: "local" } },
    { settings: { cleanupCloudMode: "byok" } },
    { manager: { voiceAgentRequested: true } },
    { manager: { translationRequested: true } },
    { manager: { sttConfig: {} } },
  ];
  for (const entry of blocked) {
    useSettingsStore.setState({ ...good, ...entry.settings });
    Object.assign(
      manager,
      {
        voiceAgentRequested: false,
        translationRequested: false,
        sttConfig: { orukeetPipeline: "gemma12" },
      },
      entry.manager
    );
    assert.equal(
      manager.getPipelineCleanupOptions(useSettingsStore.getState()),
      undefined,
      JSON.stringify(entry)
    );
  }
  useSettingsStore.setState(good);
  Object.assign(manager, {
    voiceAgentRequested: false,
    translationRequested: false,
    sttConfig: { orukeetPipeline: "gemma12" },
  });
  const policy = {
    version: 1,
    llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
    transcription: { allowedModes: ["openwhispr", "local"], allowedByokProviders: [] },
    features: { agentEnabled: true, webSearchEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  };
  usePolicyStore.setState({ status: "managed", policy });
  // The same policy function used by reasoning dispatch must also gate warmup.
  assert.equal(manager.getPipelineCleanupOptions(useSettingsStore.getState()), undefined);
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const calls = [];
  manager.isRecordingAllowedByPolicy = () => true;
  manager.shouldUseStreaming = () => true;
  manager.getStreamingProviderName = () => "orukeet";
  manager.cacheMicrophoneDeviceId = async () => {};
  manager.getKeyterms = () => [];
  window.electronAPI.dictationRealtimeWarmup = async (options) => {
    calls.push(options);
    return { success: true };
  };
  manager.getOrCreateAudioContext = async () => ({ audioWorklet: { addModule: async () => {} } });
  manager.getWorkletBlobUrl = () => "test";
  // Warmup prepares the next ordinary dictation, whatever the last one was,
  // and leaves the last recording's input kind alone.
  manager.voiceAgentRequested = true;
  await manager.warmupStreamingConnection({ warmMic: false });
  assert.equal(calls.length, 1);
  assert.equal(manager.voiceAgentRequested, true);
  assert.equal(manager.getPipelineCleanupOptions(useSettingsStore.getState()), undefined);
  assert.deepEqual(
    calls[0].pipelineOptions,
    manager.getPipelineCleanupOptions(useSettingsStore.getState(), { voiceAgentRequested: false })
  );
  assert.ok(calls[0].pipelineOptions);
});

test("with Tone & Style on, a streaming start streams audio while it waits to mint combined cleanup for the app it learns in time, and the next warmup expects the same", async (t) => {
  const { window, useSettingsStore, createManager } = await load(t, "orukeet-pipeline-tone-");
  useSettingsStore.setState({ ...good, toneStyleEnabled: true });
  let classify;
  window.electronAPI.captureDictationAppCategory = () =>
    new Promise((resolve) => (classify = resolve));
  let audioWired = false;
  globalThis.AudioWorkletNode = class {
    constructor() {
      audioWired = true;
      this.port = {};
    }
  };
  t.after(() => delete globalThis.AudioWorkletNode);
  const audioNode = { connect() {} };
  const minted = [];
  const unsubscribe = () => () => {};
  const manager = createManager({
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
    workletModuleLoaded: true,
    preparedMicCapture: { take: async () => null },
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
    getStreamingProviderName: () => "orukeet",
    getStreamingProvider: () => ({
      onPartial: unsubscribe,
      onFinal: unsubscribe,
      onError: unsubscribe,
      onSessionEnd: unsubscribe,
      start: async (options) => {
        minted.push(options.pipelineOptions);
        return { success: true };
      },
    }),
    beginMicRecovery: async () => {},
    getEffectiveSttLanguage: () => "en",
    getKeyterms: () => [],
    onStateChange() {},
  });

  manager.beginToneStyleCapture();
  const starting = manager.startStreamingRecording();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(audioWired, true);
  assert.equal(minted.length, 0);
  classify("email");
  assert.equal(await starting, true);
  assert.equal(audioWired, true);
  assert.equal(minted[0].tone, "excited");
  assert.equal(minted[0].appCategory, "email");
  // A fallback cleanup at stop gets the same tone.
  assert.deepEqual(await manager.consumeToneStyle(), { appCategory: "email", tone: "excited" });

  const warmed = [];
  window.electronAPI.dictationRealtimeWarmup = async (options) => {
    warmed.push(options.pipelineOptions);
    return { success: true };
  };
  Object.assign(manager, {
    shouldUseStreaming: () => true,
    cacheMicrophoneDeviceId: async () => {},
  });
  await manager.warmupStreamingConnection({ warmMic: false });
  assert.deepEqual(warmed, minted);

  // An app still unknown after the start's short wait (a Wayland AT-SPI target
  // takes about a second) gets no combined cleanup, and neither does the next
  // warmup.
  Object.assign(manager, { isRecording: false, isStreaming: false });
  manager.beginToneStyleCapture();
  assert.equal(await manager.startStreamingRecording(), true);
  assert.equal(minted.length, 2);
  assert.equal(minted[1], undefined);
  await manager.warmupStreamingConnection({ warmMic: false });
  assert.equal(warmed.length, 2);
  assert.equal(warmed[1], undefined);
});
