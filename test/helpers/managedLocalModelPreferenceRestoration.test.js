const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const TRANSCRIPTION_KEYS = [
  "transcriptionMode",
  "useLocalWhisper",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "cloudTranscriptionMode",
  "cloudTranscriptionProvider",
  "cloudTranscriptionModel",
  "cloudTranscriptionBaseUrl",
  "remoteTranscriptionType",
  "remoteTranscriptionUrl",
  "remoteTranscriptionModel",
  "meetingTranscriptionMode",
  "meetingUseLocalWhisper",
  "meetingLocalTranscriptionProvider",
  "meetingWhisperModel",
  "meetingParakeetModel",
  "meetingCloudTranscriptionMode",
  "meetingCloudTranscriptionProvider",
  "meetingCloudTranscriptionModel",
  "meetingCloudTranscriptionBaseUrl",
  "meetingRemoteTranscriptionType",
  "meetingRemoteTranscriptionUrl",
  "uploadTranscriptionMode",
  "uploadUseLocalWhisper",
  "uploadLocalTranscriptionProvider",
  "uploadWhisperModel",
  "uploadParakeetModel",
  "uploadCloudTranscriptionMode",
  "uploadCloudTranscriptionProvider",
  "uploadCloudTranscriptionModel",
  "uploadCloudTranscriptionBaseUrl",
  "transcriptionModelByProvider",
];

const REASONING_KEYS = [
  "cleanupMode",
  "cleanupProvider",
  "cleanupModel",
  "cleanupCloudMode",
  "cleanupCloudBaseUrl",
  "cleanupRemoteUrl",
  "noteFormattingMode",
  "noteFormattingProvider",
  "noteFormattingModel",
  "noteFormattingCloudMode",
  "noteFormattingCloudBaseUrl",
  "noteFormattingRemoteUrl",
  "dictationAgentMode",
  "dictationAgentProvider",
  "dictationAgentModel",
  "dictationAgentCloudMode",
  "dictationAgentCloudBaseUrl",
  "dictationAgentRemoteUrl",
  "chatAgentMode",
  "chatAgentProvider",
  "chatAgentModel",
  "chatAgentCloudMode",
  "chatAgentCloudBaseUrl",
  "chatAgentRemoteUrl",
  "translationMode",
  "translationProvider",
  "translationModel",
  "translationCloudMode",
  "translationCloudBaseUrl",
  "translationRemoteUrl",
];

const MUTATED_TRANSCRIPTION_KEYS = [
  "transcriptionMode",
  "useLocalWhisper",
  "localTranscriptionProvider",
  "whisperModel",
  "parakeetModel",
  "meetingTranscriptionMode",
  "meetingUseLocalWhisper",
  "meetingLocalTranscriptionProvider",
  "meetingWhisperModel",
  "meetingParakeetModel",
  "meetingCloudTranscriptionMode",
  "meetingCloudTranscriptionProvider",
  "meetingCloudTranscriptionModel",
  "uploadTranscriptionMode",
  "uploadUseLocalWhisper",
  "uploadLocalTranscriptionProvider",
  "uploadWhisperModel",
  "uploadParakeetModel",
  "uploadCloudTranscriptionMode",
  "uploadCloudTranscriptionProvider",
  "uploadCloudTranscriptionModel",
  "transcriptionModelByProvider",
];

const MUTATED_REASONING_KEYS = [
  "cleanupMode",
  "cleanupProvider",
  "cleanupModel",
  "noteFormattingMode",
  "noteFormattingProvider",
  "noteFormattingModel",
  "dictationAgentMode",
  "dictationAgentProvider",
  "dictationAgentModel",
  "chatAgentMode",
  "chatAgentProvider",
  "chatAgentModel",
  "translationMode",
  "translationProvider",
  "translationModel",
];

function pick(state, keys) {
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

function localModels(transcription, reasoning, version = 1) {
  return {
    transcription,
    reasoning,
    version,
    updatedAt: "2026-08-20T00:00:00.000Z",
    updatedByUserId: null,
  };
}

async function loadManagedSettings(t, initialStorage = {}) {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      _llmScopeKeysMigrated: "1",
      _agentModeMigrated: "1",
      uploadTranscriptionMigrated: "true",
      ...initialStorage,
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-preference-restoration-",
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const managedSettings = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModelSettings.ts"
  );
  return { useSettingsStore, ...managedSettings };
}

test("managed A to B retains baselines and authoritative category removal restores exact routes", async (t) => {
  const { useSettingsStore, enforceManagedLocalModelSettings, reconcileManagedLocalModelSettings } =
    await loadManagedSettings(t);
  const settings = useSettingsStore.getState();

  settings.setCloudTranscriptionForAllScopes({
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-transcribe",
  });
  settings.setMeetingTranscriptionMode("self-hosted");
  settings.setMeetingCloudTranscriptionMode("");
  settings.setMeetingCloudTranscriptionProvider("deepgram");
  settings.setMeetingCloudTranscriptionModel("nova-3-medical");
  settings.setMeetingCloudTranscriptionBaseUrl("https://meeting.example.test");
  settings.setUploadTranscriptionMode("openwhispr");
  settings.setUploadCloudTranscriptionMode("");
  settings.setUploadCloudTranscriptionProvider("");
  settings.setUploadCloudTranscriptionModel("");
  settings.setUploadCloudTranscriptionBaseUrl("");
  settings.setCloudReasoningForAllScopes({
    cleanupCloudMode: "byok",
    cleanupProvider: "openai",
    cleanupModel: "gpt-5-mini",
    useCleanupModel: true,
    useDictationAgent: true,
  });
  settings.setNoteFormattingMode("openwhispr");
  settings.setNoteFormattingProvider("");
  settings.setNoteFormattingModel("");
  settings.setNoteFormattingCloudMode("");
  settings.setChatAgentMode("self-hosted");
  settings.setChatAgentProvider("custom");
  settings.setChatAgentModel("personal-chat-model");
  settings.setChatAgentCloudMode("byok");

  const personalTranscription = pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS);
  const personalReasoning = pick(useSettingsStore.getState(), REASONING_KEYS);

  enforceManagedLocalModelSettings("transcription", {
    provider: "whisper",
    modelId: "whisper-large-v3-turbo",
  });
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    false
  );
  enforceManagedLocalModelSettings("transcription", {
    provider: "nvidia",
    modelId: "nvidia-parakeet-tdt-0.6b-v3",
  });
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "llama", modelId: "llama-3.2-3b-instruct-q4_k_m" },
    false
  );

  const managedTranscription = pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS);
  const managedReasoning = pick(useSettingsStore.getState(), REASONING_KEYS);
  assert.notDeepEqual(managedTranscription, personalTranscription);
  assert.notDeepEqual(managedReasoning, personalReasoning);

  for (const status of ["loading", "error", "idle"]) {
    reconcileManagedLocalModelSettings({
      ownsReconciliation: true,
      status,
      localModels: null,
    });
    assert.deepEqual(pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS), managedTranscription);
    assert.deepEqual(pick(useSettingsStore.getState(), REASONING_KEYS), managedReasoning);
  }

  reconcileManagedLocalModelSettings({
    ownsReconciliation: false,
    status: "ready",
    localModels: localModels(
      [],
      [{ provider: "llama", modelId: "llama-3.2-3b-instruct-q4_k_m" }],
      2
    ),
  });
  assert.deepEqual(pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS), managedTranscription);

  reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: localModels(
      [],
      [{ provider: "llama", modelId: "llama-3.2-3b-instruct-q4_k_m" }],
      2
    ),
  });
  assert.deepEqual(pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS), personalTranscription);
  assert.deepEqual(pick(useSettingsStore.getState(), REASONING_KEYS), managedReasoning);

  useSettingsStore.getState().setUseCleanupModel(false);
  reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: null,
  });
  assert.deepEqual(pick(useSettingsStore.getState(), REASONING_KEYS), personalReasoning);
  assert.equal(useSettingsStore.getState().useDictationAgent, true);
  assert.equal(useSettingsStore.getState().useCleanupModel, false);
});

test("inherited route keys and model memory return to raw absence after managed enforcement", async (t) => {
  const { useSettingsStore, enforceManagedLocalModelSettings, reconcileManagedLocalModelSettings } =
    await loadManagedSettings(t);
  const mutatedKeys = [...MUTATED_TRANSCRIPTION_KEYS, ...MUTATED_REASONING_KEYS];
  const hydratedBaseline = pick(useSettingsStore.getState(), mutatedKeys);
  for (const key of mutatedKeys) assert.equal(localStorage.getItem(key), null, key);
  assert.equal(localStorage.getItem("useCleanupModel"), null);
  assert.equal(localStorage.getItem("useDictationAgent"), null);

  enforceManagedLocalModelSettings("transcription", {
    provider: "nvidia",
    modelId: "nvidia-parakeet-tdt-0.6b-v3",
  });
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    true
  );

  assert.equal(localStorage.getItem("useCleanupModel"), null);
  assert.equal(localStorage.getItem("useDictationAgent"), null);
  const storageOperations = [];
  const originalSetItem = localStorage.setItem;
  const originalRemoveItem = localStorage.removeItem;
  localStorage.setItem = (key, value) => {
    storageOperations.push(["set", key, String(value)]);
    originalSetItem(key, value);
  };
  localStorage.removeItem = (key) => {
    storageOperations.push(["remove", key]);
    originalRemoveItem(key);
  };

  reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: null,
  });

  assert.deepEqual(pick(useSettingsStore.getState(), mutatedKeys), hydratedBaseline);
  for (const key of mutatedKeys) assert.equal(localStorage.getItem(key), null, key);
  for (const key of ["transcriptionMode", "cleanupMode", "transcriptionModelByProvider"]) {
    const setIndex = storageOperations.findIndex(
      ([operation, operationKey]) => operation === "set" && operationKey === key
    );
    const removeIndex = storageOperations.findIndex(
      ([operation, operationKey]) => operation === "remove" && operationKey === key
    );
    assert.ok(setIndex >= 0, `${key} should emit its hydrated value for other renderers`);
    assert.ok(
      removeIndex > setIndex,
      `${key} should become absent after the synchronization write`
    );
  }
});

test("only a forbidden agent toggle is restored, without materializing inherited defaults", async (t) => {
  const { useSettingsStore, enforceManagedLocalModelSettings, reconcileManagedLocalModelSettings } =
    await loadManagedSettings(t);
  assert.equal(useSettingsStore.getState().useDictationAgent, true);
  assert.equal(localStorage.getItem("useDictationAgent"), null);
  assert.equal(localStorage.getItem("useCleanupModel"), null);

  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    false
  );
  assert.equal(useSettingsStore.getState().useDictationAgent, false);
  assert.equal(localStorage.getItem("useDictationAgent"), "false");
  assert.equal(localStorage.getItem("useCleanupModel"), null);

  useSettingsStore.getState().setUseCleanupModel(false);
  reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: null,
  });

  assert.equal(useSettingsStore.getState().useDictationAgent, true);
  assert.equal(localStorage.getItem("useDictationAgent"), null);
  assert.equal(useSettingsStore.getState().useCleanupModel, false);
  assert.equal(localStorage.getItem("useCleanupModel"), "false");
});

test("persisted baselines survive a renderer restart and malformed snapshots fail closed", async (t) => {
  const first = await loadManagedSettings(t);
  first.useSettingsStore.getState().setCloudTranscriptionForAllScopes({
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3-turbo",
  });
  const personalModelMemory = {
    "dictation:groq": "whisper-large-v3-turbo",
    "meeting:groq": "distil-whisper-large-v3-en",
    "upload:groq": "whisper-large-v3",
  };
  localStorage.setItem("transcriptionModelByProvider", JSON.stringify(personalModelMemory));
  first.useSettingsStore.setState({ transcriptionModelByProvider: personalModelMemory });
  const personal = pick(first.useSettingsStore.getState(), TRANSCRIPTION_KEYS);
  first.enforceManagedLocalModelSettings("transcription", {
    provider: "whisper",
    modelId: "whisper-large-v3-turbo",
  });
  const persisted = localStorage.getItem(first.MANAGED_LOCAL_MODEL_PREFERENCES_KEY);
  assert.ok(persisted);
  assert.notDeepEqual(
    first.useSettingsStore.getState().transcriptionModelByProvider,
    personalModelMemory
  );

  const restartedVite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-preference-restarted-",
  });
  const { useSettingsStore: restartedSettingsStore } = await restartedVite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const restartedManagedSettings = await restartedVite.ssrLoadModule(
    "/components/onboarding/managedLocalModelSettings.ts"
  );
  assert.notEqual(restartedSettingsStore, first.useSettingsStore);
  assert.notDeepEqual(pick(restartedSettingsStore.getState(), TRANSCRIPTION_KEYS), personal);

  restartedManagedSettings.reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: null,
  });
  assert.deepEqual(pick(restartedSettingsStore.getState(), TRANSCRIPTION_KEYS), personal);
  assert.deepEqual(
    JSON.parse(localStorage.getItem("transcriptionModelByProvider")),
    personal.transcriptionModelByProvider
  );

  restartedManagedSettings.enforceManagedLocalModelSettings("transcription", {
    provider: "whisper",
    modelId: "whisper-large-v3-turbo",
  });
  localStorage.setItem(restartedManagedSettings.MANAGED_LOCAL_MODEL_PREFERENCES_KEY, "{malformed");
  const stillManaged = pick(restartedSettingsStore.getState(), TRANSCRIPTION_KEYS);
  restartedManagedSettings.reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: null,
  });
  assert.deepEqual(pick(restartedSettingsStore.getState(), TRANSCRIPTION_KEYS), stillManaged);

  localStorage.setItem(
    restartedManagedSettings.MANAGED_LOCAL_MODEL_PREFERENCES_KEY,
    JSON.stringify({ version: 1, transcription: personal })
  );
  restartedManagedSettings.reconcileManagedLocalModelSettings({
    ownsReconciliation: true,
    status: "ready",
    localModels: null,
  });
  assert.deepEqual(pick(restartedSettingsStore.getState(), TRANSCRIPTION_KEYS), stillManaged);
});

test("central sign out restores both managed categories", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      _llmScopeKeysMigrated: "1",
      _agentModeMigrated: "1",
      uploadTranscriptionMigrated: "true",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-preference-signout-",
    mockModules: {
      "better-auth/react": `
        export function createAuthClient() {
          return { signOut: async () => {}, $store: { notify() {} } };
        }
      `,
      "@better-auth/sso/client": "export function ssoClient() { return {}; }",
      "/utils/externalLinks": "export function openExternalLink() {}",
      "/lib/authRequestContext": `
        export const authContextFetch = fetch;
        export function handleAuthRequestError() {}
        export function handleAuthRequestResponse() {}
        export function handleAuthRequestSuccess() {}
        export function observeAuthTokenStateEvent() {}
        export function prepareAuthRequest() {}
      `,
    },
  });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { enforceManagedLocalModelSettings } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModelSettings.ts"
  );
  const { signOut } = await vite.ssrLoadModule("/lib/auth.ts");
  useSettingsStore.getState().setCloudTranscriptionForAllScopes({
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-transcribe",
  });
  useSettingsStore.getState().setCloudReasoningForAllScopes({
    cleanupCloudMode: "byok",
    cleanupProvider: "openai",
    cleanupModel: "gpt-5-mini",
    useDictationAgent: true,
  });
  const personalTranscription = pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS);
  const personalReasoning = pick(useSettingsStore.getState(), REASONING_KEYS);
  enforceManagedLocalModelSettings("transcription", {
    provider: "whisper",
    modelId: "whisper-large-v3-turbo",
  });
  enforceManagedLocalModelSettings(
    "reasoning",
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    false
  );

  await signOut();

  assert.deepEqual(pick(useSettingsStore.getState(), TRANSCRIPTION_KEYS), personalTranscription);
  assert.deepEqual(pick(useSettingsStore.getState(), REASONING_KEYS), personalReasoning);
});
