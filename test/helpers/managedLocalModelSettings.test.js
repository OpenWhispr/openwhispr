const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("managed selections replace every cloud route before missing artifacts finish", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-local-preterminal-settings-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { enforceManagedLocalModelSettings } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModelSettings.ts"
  );
  const settings = useSettingsStore.getState();
  settings.setCloudTranscriptionForAllScopes({
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-transcribe",
  });
  settings.setCloudReasoningForAllScopes({
    cleanupCloudMode: "byok",
    cleanupProvider: "openai",
    cleanupModel: "gpt-5-mini",
    useCleanupModel: true,
    useDictationAgent: true,
  });

  enforceManagedLocalModelSettings("transcription", {
    provider: "nvidia",
    modelId: "nvidia-parakeet-tdt-0.6b-v3",
  });
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    true
  );
  useSettingsStore.getState().setUseCleanupModel(false);
  useSettingsStore.getState().setUseDictationAgent(false);
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    true
  );

  const enforced = useSettingsStore.getState();
  assert.equal(enforced.useCleanupModel, false);
  assert.equal(enforced.useDictationAgent, false);
  for (const [mode, provider, model] of [
    [
      enforced.transcriptionMode,
      enforced.localTranscriptionProvider,
      enforced.parakeetModel,
    ],
    [
      enforced.meetingTranscriptionMode,
      enforced.meetingLocalTranscriptionProvider,
      enforced.meetingParakeetModel,
    ],
    [
      enforced.uploadTranscriptionMode,
      enforced.uploadLocalTranscriptionProvider,
      enforced.uploadParakeetModel,
    ],
  ]) {
    assert.deepEqual([mode, provider, model], [
      "local",
      "nvidia",
      "nvidia-parakeet-tdt-0.6b-v3",
    ]);
  }
  for (const [mode, provider, model] of [
    [enforced.cleanupMode, enforced.cleanupProvider, enforced.cleanupModel],
    [
      enforced.noteFormattingMode,
      enforced.noteFormattingProvider,
      enforced.noteFormattingModel,
    ],
    [enforced.dictationAgentMode, enforced.dictationAgentProvider, enforced.dictationAgentModel],
    [enforced.chatAgentMode, enforced.chatAgentProvider, enforced.chatAgentModel],
    [enforced.translationMode, enforced.translationProvider, enforced.translationModel],
  ]) {
    assert.deepEqual([mode, provider, model], ["local", "qwen", "qwen3.5-4b-q4_k_m"]);
  }

  useSettingsStore.getState().setUseDictationAgent(true);
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    false
  );
  assert.equal(useSettingsStore.getState().useCleanupModel, false);
  assert.equal(useSettingsStore.getState().useDictationAgent, false);
});
