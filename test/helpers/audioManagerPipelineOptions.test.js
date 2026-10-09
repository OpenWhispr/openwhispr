const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("combined cleanup options honor every eligibility guard and use the actual prompt/dictionary", async (t) => {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "orukeet-pipeline-guards-",
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
  };
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    sttConfig: { orukeetPipeline: "gemma12" },
    getCleanupLanguage: () => "en",
  });
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState(good);
  assert.deepEqual(manager.getPipelineCleanupOptions(useSettingsStore.getState()), {
    agentName: "OpenWhispr",
    customDictionary: ["Orukeet"],
    customPrompt: good.customPrompts.cleanup,
    language: "en",
    locale: "en",
  });
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
  await manager.warmupStreamingConnection({ warmMic: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].pipelineOptions,
    manager.getPipelineCleanupOptions(useSettingsStore.getState())
  );
});
