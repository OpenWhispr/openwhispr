const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const identity = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 12,
};

function storageSnapshot(storage) {
  return JSON.stringify(
    Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index);
      return [key, storage.getItem(key)];
    })
  );
}

test("managed local effective settings overlay every affected scope without mutating preferences", async (t) => {
  const browser = installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "whisper-large-v3-turbo",
      cloudTranscriptionBaseUrl: "https://personal-stt.example/v1",
      cleanupMode: "self-hosted",
      cleanupProvider: "custom",
      cleanupModel: "personal-model",
      cleanupCloudBaseUrl: "https://personal-llm.example/v1",
      cleanupRemoteUrl: "https://personal-cleanup.example/v1",
      dictationAgentCloudBaseUrl: "https://personal-agent.example/v1",
      dictationAgentRemoteUrl: "https://personal-agent-remote.example/v1",
      noteFormattingCloudBaseUrl: "https://personal-note.example/v1",
      noteFormattingRemoteUrl: "https://personal-note-remote.example/v1",
      chatAgentCloudBaseUrl: "https://personal-chat.example/v1",
      chatAgentRemoteUrl: "https://personal-chat-remote.example/v1",
      translationCloudBaseUrl: "https://personal-translation.example/v1",
      translationRemoteUrl: "https://personal-translation-remote.example/v1",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-local-effective-settings-test-",
  });
  const { useSettingsStore, getSettings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { rememberManagedLocalModelBinding } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModels.ts"
  );

  useSettingsStore.setState({
    meetingTranscriptionMode: "providers",
    meetingUseLocalWhisper: false,
    meetingLocalTranscriptionProvider: "whisper",
    meetingWhisperModel: "tiny",
    meetingParakeetModel: "personal-parakeet",
    uploadTranscriptionMode: "providers",
    uploadUseLocalWhisper: false,
    uploadLocalTranscriptionProvider: "whisper",
    uploadWhisperModel: "tiny",
    uploadParakeetModel: "personal-parakeet",
    dictationAgentMode: "providers",
    dictationAgentProvider: "openai",
    dictationAgentModel: "gpt-4o-mini",
    dictationAgentCloudBaseUrl: "https://personal-agent.example/v1",
    dictationAgentRemoteUrl: "https://personal-agent-remote.example/v1",
    dictationAgentCustomApiKey: "agent-key",
    noteFormattingMode: "providers",
    noteFormattingProvider: "openai",
    noteFormattingModel: "gpt-4o-mini",
    noteFormattingCloudBaseUrl: "https://personal-note.example/v1",
    noteFormattingRemoteUrl: "https://personal-note-remote.example/v1",
    noteFormattingCustomApiKey: "note-key",
    chatAgentMode: "providers",
    chatAgentProvider: "openai",
    chatAgentModel: "gpt-4o-mini",
    chatAgentCloudBaseUrl: "https://personal-chat.example/v1",
    chatAgentRemoteUrl: "https://personal-chat-remote.example/v1",
    chatAgentCustomApiKey: "chat-key",
    translationMode: "providers",
    translationProvider: "openai",
    translationModel: "gpt-4o-mini",
    translationCloudBaseUrl: "https://personal-translation.example/v1",
    translationRemoteUrl: "https://personal-translation-remote.example/v1",
    translationCustomApiKey: "translation-key",
    cleanupRemoteUrl: "https://personal-cleanup.example/v1",
    cleanupCustomApiKey: "cleanup-key",
  });
  const raw = useSettingsStore.getState();
  const rawSnapshot = JSON.stringify(raw);
  useEnterpriseIdentityStore.setState({
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    authGeneration: identity.authGeneration,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    config: {
      workspaceId: identity.workspaceId,
      version: 12,
      generation: identity.configGeneration,
      identity: {},
      providers: [],
      localModels: {
        selections: [
          { provider: "nvidia", model: "parakeet-tdt-0.6b-v3" },
          { provider: "qwen", model: "qwen3.5-9b-q4_k_m" },
        ],
      },
    },
  });
  rememberManagedLocalModelBinding({
    ...identity,
    category: "dictation",
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
  });
  rememberManagedLocalModelBinding({
    ...identity,
    category: "assistant",
    provider: "qwen",
    model: "qwen3.5-9b-q4_k_m",
  });

  usePolicyStore.setState({
    status: "managed",
    managed: true,
    appVersion: "1.8.1",
    policy: {
      version: 1,
      transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
      llm: {
        allowedModes: ["providers"],
        allowedByokProviders: ["openai"],
        allowedEnterpriseProviders: [],
      },
      features: { agentEnabled: true, webSearchEnabled: true },
      sharing: { externalLinkSharing: "allowed" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: true,
      },
      minAppVersion: null,
    },
  });
  const localStorageSnapshot = storageSnapshot(browser.storage);

  const effective = getSettings();
  for (const prefix of ["", "meeting", "upload"]) {
    const mode = prefix ? `${prefix}TranscriptionMode` : "transcriptionMode";
    const useLocal = prefix ? `${prefix}UseLocalWhisper` : "useLocalWhisper";
    const provider = prefix ? `${prefix}LocalTranscriptionProvider` : "localTranscriptionProvider";
    const model = prefix ? `${prefix}ParakeetModel` : "parakeetModel";
    assert.equal(effective[mode], "local", `${prefix || "dictation"} mode`);
    assert.equal(effective[useLocal], true, `${prefix || "dictation"} local`);
    assert.equal(effective[provider], "nvidia", `${prefix || "dictation"} provider`);
    assert.equal(effective[model], "parakeet-tdt-0.6b-v3", `${prefix || "dictation"} model`);
  }
  for (const prefix of [
    "cleanup",
    "dictationAgent",
    "noteFormatting",
    "chatAgent",
    "translation",
  ]) {
    assert.equal(effective[`${prefix}Mode`], "local", `${prefix} mode`);
    assert.equal(effective[`${prefix}Provider`], "qwen", `${prefix} provider`);
    assert.equal(effective[`${prefix}Model`], "qwen3.5-9b-q4_k_m", `${prefix} model`);
    assert.equal(effective[`${prefix}CloudMode`], "byok", `${prefix} cloud mode`);
    assert.equal(effective[`${prefix}CloudBaseUrl`], "", `${prefix} cloud endpoint`);
    assert.equal(effective[`${prefix}RemoteUrl`], "", `${prefix} remote endpoint`);
    assert.equal(effective[`${prefix}CustomApiKey`], "", `${prefix} custom key`);
  }
  assert.equal(JSON.stringify(useSettingsStore.getState()), rawSnapshot);
  assert.equal(storageSnapshot(browser.storage), localStorageSnapshot);
  assert.equal(browser.storage.getItem("managedLocalModelSettings"), null);
  assert.equal(browser.storage.getItem("managedLocalModelSettingsV1"), null);

  usePolicyStore.setState({ status: "unmanaged", managed: false, policy: null });
  useEnterpriseIdentityStore.setState({ config: null, status: "idle", verdict: "unknown" });
  assert.equal(
    JSON.stringify(getSettings()),
    rawSnapshot,
    "clearing config reveals raw preferences"
  );
});
