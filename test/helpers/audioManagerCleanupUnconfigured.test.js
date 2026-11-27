const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const UNCONFIGURED = "hooks.audioRecording.cleanupUnconfigured";
const SIGNED_OUT = "hooks.audioRecording.cleanupSignedOut";

async function loadRealAudioManager(t) {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-audio-cleanup-unconfigured-",
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
  useSettingsStore.setState({
    isSignedIn: false,
    useCleanupModel: true,
    cleanupMode: "providers",
    cleanupProvider: "openai",
    cleanupModel: "",
    useDictationAgent: false,
    useDictationTranslation: false,
    customPrompts: { cleanup: "" },
    preferredLanguage: "en",
  });
  const manager = Object.assign(Object.create(AudioManager.prototype), {
    voiceAgentRequested: false,
    translationRequested: false,
    pendingCleanupFailure: null,
    _shownCleanupSetupKey: null,
    getEffectiveSttLanguage: () => "en",
    getWhisperPrompt: () => null,
    isDictionaryEcho: () => false,
    isReasoningAvailable: async () => true,
    finalizeChineseScript: async (text) => text,
  });
  return {
    window,
    manager,
    usePolicyStore,
    setSettings: (next) => useSettingsStore.setState(next),
  };
}

async function dictate(manager, text) {
  assert.equal(await manager.processTranscriptionCore(text, "local"), text);
  return manager._takePendingResultExtras().cleanupFailure;
}

test("cleanup on with no model warns once it is shown, and again after a fix breaks", async (t) => {
  const { window, manager, setSettings } = await loadRealAudioManager(t);

  const first = await dictate(manager, "hello there");
  assert.equal(first.messageKey, UNCONFIGURED);
  assert.equal(first.settingsTarget, "llms");

  // A notice that never reached the screen (a cancelled dictation) is not used up.
  assert.equal((await dictate(manager, "hello again")).messageKey, UNCONFIGURED);
  manager.markCleanupNoticeShown(first);
  assert.equal(await dictate(manager, "and again"), undefined);

  // A reachable model runs cleanup and forgets the warning, so the same broken
  // setup warns again once the model is gone.
  setSettings({ cleanupMode: "local", cleanupProvider: "local", cleanupModel: "test-model" });
  window.electronAPI.processLocalReasoning = async () => ({ success: true, text: "Cleaned." });
  assert.equal(await manager.processTranscriptionCore("fixed now", "local"), "Cleaned.");
  assert.equal(manager._takePendingResultExtras().cleanupFailure, undefined);
  setSettings({ cleanupMode: "providers", cleanupProvider: "openai", cleanupModel: "" });
  assert.equal((await dictate(manager, "broken again")).messageKey, UNCONFIGURED);

  setSettings({ useCleanupModel: false });
  assert.equal(await dictate(manager, "cleanup off"), undefined);

  setSettings({ useCleanupModel: true, cleanupMode: "openwhispr", cleanupCloudMode: "openwhispr" });
  assert.equal((await dictate(manager, "signed out")).messageKey, SIGNED_OUT);
});

test("cleanup with nothing to run on warns even when the assistant is reachable", async (t) => {
  const { manager, setSettings } = await loadRealAudioManager(t);
  // The Cloud assistant skips the early "no model" return; cleanup still can't run.
  setSettings({
    isSignedIn: true,
    useDictationAgent: true,
    dictationAgentMode: "openwhispr",
    dictationAgentCloudMode: "openwhispr",
  });
  manager.isReasoningAvailable = async () => false;
  assert.equal((await dictate(manager, "local words")).messageKey, UNCONFIGURED);
});

test("a BYOK cleanup model with no API key reports the missing key", async (t) => {
  const { manager, setSettings } = await loadRealAudioManager(t);
  // A model is selected, but no provider has a key, so the availability check fails.
  setSettings({ cleanupModel: "gpt-5-mini" });
  manager.isReasoningAvailable = async () => false;

  const failure = await dictate(manager, "no key words");
  assert.equal(failure.messageKey, "providerErrors.keyMissing");
  assert.deepEqual(failure.messageParams, { provider: "OpenAI" });
  assert.equal(failure.surface, "llm");
  assert.equal(failure.settingsTarget, "llms");

  // A local model needs no key, so it is never reported as one missing.
  setSettings({ cleanupMode: "local", cleanupProvider: "local", cleanupModel: "test-model" });
  assert.equal(await dictate(manager, "local model words"), undefined);
});

test("the Cloud batch and streaming paths warn when they skip an unreachable cleanup", async (t) => {
  const { window, manager, setSettings } = await loadRealAudioManager(t);
  // Signed in for Cloud transcription, with cleanup set to providers and no model.
  setSettings({ isSignedIn: true, cleanupCloudMode: "openwhispr" });
  window.electronAPI.cloudTranscribe = async () => ({ success: true, text: "cloud words" });
  window.electronAPI.cloudStreamingUsage = async () => ({ success: true });

  const batch = await manager.processWithOpenWhisprCloud(new Blob(["synthetic audio"]));
  assert.equal(batch.text, "cloud words");
  assert.equal(manager._takePendingResultExtras().cleanupFailure?.messageKey, UNCONFIGURED);

  let streamed;
  Object.assign(manager, {
    streamingFinalText: "streamed words",
    streamingCleanupFns: [],
    micRecovery: { stop() {} },
    finishStreamingFallbackSegment: async () => {},
    mergeRecordedSegments: async () => null,
    awaitStreamingTextSettled: async () => {},
    getStreamingProvider: () => ({
      awaitsFinalTranscript: true,
      stop: async () => ({ success: true }),
    }),
    getStreamingProviderName: () => "openwhispr",
    shouldUseStreaming: () => false,
    onTranscriptionComplete: (value) => {
      streamed = value;
    },
  });
  await manager._finalizeStreamingRecording(null);
  assert.equal(streamed.text, "streamed words");
  assert.equal(streamed.cleanupFailure?.messageKey, UNCONFIGURED);
});

const APPROVED = "qwen3.5-2b-q4_k_m";
const BLOCKED = "qwen3.5-9b-q4_k_m";

async function loadManagedLlmManager(t, settings) {
  const { managedPolicy } = require("./harness/policyFixtures");
  const context = await loadRealAudioManager(t);
  const { usePolicyStore } = context;
  const policy = managedPolicy({
    llm: { allowedModes: ["local"], allowedLocalModels: [APPROVED] },
  });
  policy.features = { ...policy.features, agentEnabled: true };
  usePolicyStore.setState({
    status: "managed",
    managed: true,
    appVersion: "1.11.1",
    policy,
    accountId: "account",
    authGeneration: 1,
  });
  context.setSettings({
    cleanupMode: "local",
    cleanupProvider: "qwen",
    cleanupModel: APPROVED,
    useDictationAgent: true,
    dictationAgentMode: "local",
    dictationAgentProvider: "qwen",
    dictationAgentModel: BLOCKED,
    ...settings,
  });
  const reasoningCalls = [];
  context.window.electronAPI = {
    ...context.window.electronAPI,
    processLocalReasoning: async (text, model) => {
      reasoningCalls.push(model);
      return { success: true, text: `CLEANED:${text}` };
    },
    cancelLocalReasoning: async () => {},
  };
  context.window.localStorage.setItem("agentName", "Sam");
  Object.assign(context.manager, {
    consumeToneStyle: async () => null,
    consumeScreenContext: async () => null,
    consumeSelectionCapture: async () => ({ status: "none" }),
    consumeAssistantSelectionContext: () => null,
  });
  return { ...context, reasoningCalls };
}

for (const [label, settings] of [
  ["with cleanup approved", {}],
  ["with cleanup off", { useCleanupModel: false }],
]) {
  test(`a wake-word command to a blocked assistant goes to the panel, never into the text field, ${label}`, async (t) => {
    const { manager, reasoningCalls } = await loadManagedLlmManager(t, settings);

    manager.isProcessing = true;
    await manager.processTranscription("Hey Sam, draft an email to Bob", "test");

    assert.deepEqual(reasoningCalls, []);
    assert.equal(manager.pendingAssistantConversation?.transcript, "draft an email to Bob");
  });
}

test("with the wake word switched off, a blocked assistant changes nothing: it's dictation", async (t) => {
  const { manager, reasoningCalls } = await loadManagedLlmManager(t, { useDictationAgent: false });

  manager.isProcessing = true;
  const text = await manager.processTranscription("Hey Sam, draft an email to Bob", "test");

  assert.deepEqual(reasoningCalls, [APPROVED]);
  assert.match(text, /CLEANED:/);
  assert.equal(manager.pendingAssistantConversation, undefined);
});

test("ordinary dictation still gets cleaned up while the assistant is blocked", async (t) => {
  const { manager, reasoningCalls } = await loadManagedLlmManager(t, {});

  const text = await manager.processTranscription("buy milk and eggs", "test");

  assert.deepEqual(reasoningCalls, [APPROVED]);
  assert.match(text, /CLEANED:/);
});

test("a translation that skips a blocked cleanup says so", async (t) => {
  const { manager } = await loadManagedLlmManager(t, {
    cleanupModel: BLOCKED,
    useDictationAgent: false,
    useDictationTranslation: true,
    translationMode: "local",
    translationProvider: "qwen",
    translationModel: APPROVED,
    translationTargetLanguage: "fr",
  });
  manager.translationRequested = true;

  await manager.processTranscription("hello there", "test");

  assert.equal(manager.pendingCleanupFailure?.messageKey, "models.policy.modelBlocked");
});
