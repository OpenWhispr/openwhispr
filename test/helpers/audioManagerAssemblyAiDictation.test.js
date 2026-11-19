const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const VERBATIM = "um so can we move the meeting to thursday";
const CLEANED = "Can we move the meeting to Thursday?";

test("AssemblyAI Dictation sends the recording and keyterms, and hands back both texts", async (t) => {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assemblyai-dictation-proxy-",
    settingsKey: "__assemblyAiDictationSettings",
  });
  loaded.setSettings({
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionProvider: "assemblyai",
    cloudTranscriptionModel: "dictation",
    transcriptionMode: "providers",
    assemblyaiApiKey: "aai-key",
    openaiApiKey: "",
    customDictionary: ["Piha"],
    snippets: [],
    sharedDictionaryHints: { space: [], workspace: [] },
  });
  const payloads = [];
  loaded.window.electronAPI.proxyAssemblyAiTranscription = async (payload) => {
    payloads.push(payload);
    return { text: VERBATIM, cleanedText: CLEANED };
  };
  // Only an AssemblyAI key is saved: the key lookup must not ask for OpenAI's.
  loaded.window.electronAPI.getOpenAIKey = async () => null;
  let cleanupOptions;

  const result = await loaded
    .createManager({
      cachedApiKey: null,
      cachedApiKeyProvider: null,
      getEffectiveSttLanguage: () => "auto",
      shouldStreamTranscription: () => false,
      processTranscription: async (value, _source, _wasCancelled, options) => {
        cleanupOptions = options;
        return options.cleanedText;
      },
      isReasoningAvailable: async () => false,
    })
    .processWithOpenAIAPI(new Blob([new ArrayBuffer(8)], { type: "audio/webm" }), {
      durationSeconds: 1201,
    });

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].durationSeconds, 1201);
  assert.equal(payloads[0].mimeType, "audio/webm");
  assert.equal(payloads[0].language, undefined, "auto-detect sends no language");
  assert.deepEqual(payloads[0].keyterms, ["Piha"]);
  assert.deepEqual(cleanupOptions, { cleanedText: CLEANED });
  assert.equal(result.rawText, VERBATIM);
  assert.equal(result.text, CLEANED);
});

async function loadCleanupManager(t) {
  const { window } = installBrowserGlobals(t, { window: { dispatchEvent() {} } });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  t.after(() => delete navigator.onLine);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assemblyai-dictation-cleanup-",
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
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "test-model",
    useDictationAgent: false,
    useDictationTranslation: false,
    customPrompts: { cleanup: "" },
    toneStyleEnabled: false,
    preferredLanguage: "en",
  });
  const cleanupRequests = [];
  window.electronAPI.processLocalReasoning = async (text) => {
    cleanupRequests.push(text);
    return { success: true, text: "Cleaned by the app." };
  };
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
  const dictate = (text, cleanedText) =>
    manager.processTranscriptionCore(text, "assemblyai", () => false, { cleanedText });
  return {
    window,
    manager,
    vite,
    dictate,
    cleanupRequests,
    usePolicyStore,
    setSettings: (next) => useSettingsStore.setState(next),
  };
}

test("personal STT with optional managed cleanup sends the verbatim text to Bedrock", async (t) => {
  const { manager, window, vite, setSettings, usePolicyStore } = await loadCleanupManager(t);
  const {
    assemblyAiPolicy,
    loadAssemblyAiDictationCatalog,
    setManagedBedrockCleanup,
  } = require("./harness/policyFixtures");
  await loadAssemblyAiDictationCatalog(vite);
  usePolicyStore.setState(assemblyAiPolicy(true, true));
  await setManagedBedrockCleanup(vite, "managed_default");
  setSettings({
    transcriptionMode: "providers",
    useLocalWhisper: false,
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "assemblyai",
    cloudTranscriptionModel: "dictation",
    assemblyaiApiKey: "fixture",
    enterpriseSetupMode: "auto",
  });
  window.electronAPI.proxyAssemblyAiTranscription = async () => ({
    text: VERBATIM,
    cleanedText: CLEANED,
  });
  const cleanup = t.mock.fn(async () => "Cleaned by Bedrock.");
  manager.processWithReasoningModel = cleanup;
  assert.equal(manager.isRecordingAllowedByPolicy(), true);
  const result = await manager.processWithOpenAIAPI(new Blob(["audio"], { type: "audio/webm" }));
  assert.equal(result.text, "Cleaned by Bedrock.");
  assert.deepEqual(cleanup.mock.calls[0].arguments.slice(0, 2), [VERBATIM, "managed-model"]);
});

test("a spoken snippet survives a provider rewrite for expansion after dictation", async (t) => {
  const { dictate, cleanupRequests, setSettings } = await loadCleanupManager(t);
  const { expandSnippets } = require("../../src/utils/snippets.ts");
  const snippets = [{ trigger: "İmza", replacement: "Best regards,\nUmut" }];
  setSettings({ snippets });

  const spoken = "um please add (İmza)".normalize("NFD");
  const result = await dictate(spoken, "Please add my signature.");
  assert.equal(result, spoken);
  assert.equal(expandSnippets(result, snippets), "um please add (Best regards,\nUmut)");
  assert.deepEqual(cleanupRequests, []);

  const preserved = await dictate(spoken, "Please add imza.");
  assert.equal(expandSnippets(preserved, snippets), "Please add Best regards,\nUmut.");

  const unrelated = "um so imzalar are ready";
  const rewritten = "Imzalar are ready.";
  assert.equal(await dictate(unrelated, rewritten), rewritten);
  assert.equal(await dictate(unrelated, "Imza is ready."), unrelated);

  setSettings({ snippets: [] });
  assert.equal(await dictate(spoken, "Please add my signature."), "Please add my signature.");
});

test("provider cleanup retains every spoken snippet in order", async (t) => {
  const { dictate, setSettings } = await loadCleanupManager(t);
  setSettings({
    snippets: [
      { trigger: "signoff", replacement: "Best regards" },
      { trigger: "address", replacement: "20 High Street" },
    ],
  });
  const spoken = "um add signoff address signoff";
  assert.equal(await dictate(spoken, "Add address signoff signoff."), spoken);
  assert.equal(await dictate(spoken, "Add signoff address."), spoken);
});

test("text the provider already cleaned replaces the app's own cleanup", async (t) => {
  const { manager, dictate, cleanupRequests } = await loadCleanupManager(t);

  assert.equal(await dictate(VERBATIM, CLEANED), CLEANED);
  assert.deepEqual(cleanupRequests, [], "no second cleanup pass");
  assert.equal(manager._takePendingResultExtras().cleanupFailure, undefined);

  // Without provider cleanup the app's own cleanup runs as before.
  assert.equal(await dictate(VERBATIM, undefined), "Cleaned by the app.");
  assert.equal(cleanupRequests.length, 1);
});

test("provider cleanup needs no cleanup model of the app's own", async (t) => {
  const { manager, dictate, setSettings } = await loadCleanupManager(t);
  setSettings({ cleanupMode: "providers", cleanupProvider: "openai", cleanupModel: "" });

  assert.equal(await dictate(VERBATIM, CLEANED), CLEANED);
  assert.equal(
    manager._takePendingResultExtras().cleanupFailure,
    undefined,
    "no 'cleanup isn't set up' notice when the provider cleaned the text"
  );
});

test("cleanup turned off keeps the verbatim transcript", async (t) => {
  const { dictate, setSettings } = await loadCleanupManager(t);
  setSettings({ useCleanupModel: false });

  assert.equal(await dictate(VERBATIM, CLEANED), VERBATIM);
});

test("translation and assistant requests run on the verbatim transcript", async (t) => {
  const { manager, dictate, cleanupRequests } = await loadCleanupManager(t);

  manager.translationRequested = true;
  assert.notEqual(await dictate(VERBATIM, CLEANED), CLEANED);
  manager.translationRequested = false;

  manager.voiceAgentRequested = true;
  manager.consumeScreenContext = async () => null;
  manager.processAgentCommand = async (text) => `agent saw: ${text}`;
  assert.equal(await dictate(VERBATIM, CLEANED), `agent saw: ${VERBATIM}`);
  manager.voiceAgentRequested = false;

  assert.equal(cleanupRequests.includes(CLEANED), false);
});

test("a duplicated AssemblyAI rewrite retains the verbatim dictation", async (t) => {
  const { manager, dictate, cleanupRequests } = await loadCleanupManager(t);
  assert.equal(await dictate(VERBATIM, CLEANED + "\n" + CLEANED), VERBATIM);
  assert.equal(
    manager.pendingCleanupFailure.messageKey,
    "hooks.audioRecording.errorDescriptions.cleanupDuplicated"
  );
  assert.deepEqual(cleanupRequests, []);
});

test("the user's own cleanup prompt or tone keeps the app's cleanup", async (t) => {
  const { manager, dictate, cleanupRequests, setSettings } = await loadCleanupManager(t);
  manager.consumeToneStyle = async () => null;

  setSettings({ customPrompts: { cleanup: "Rewrite as a bulleted list." } });
  assert.equal(await dictate(VERBATIM, CLEANED), "Cleaned by the app.");

  setSettings({ customPrompts: { cleanup: "" }, toneStyleEnabled: true });
  assert.equal(await dictate(VERBATIM, CLEANED), "Cleaned by the app.");
  assert.equal(cleanupRequests.length, 2);
  for (const prompt of cleanupRequests) {
    assert.ok(prompt.includes(VERBATIM));
    assert.ok(!prompt.includes(CLEANED));
  }

  // With no model of the app's own to run them, the provider's text still beats raw.
  setSettings({ cleanupMode: "providers", cleanupProvider: "openai", cleanupModel: "" });
  assert.equal(await dictate(VERBATIM, CLEANED), CLEANED);
  assert.equal(cleanupRequests.length, 2);
});

test("the assistant's name, with no assistant to hear it, is still cleaned", async (t) => {
  const { window, dictate, setSettings } = await loadCleanupManager(t);
  window.localStorage.setItem("agentName", "Sam");
  setSettings({ cleanupMode: "providers", cleanupProvider: "openai", cleanupModel: "" });

  assert.equal(
    await dictate("um hey Sam can we move the meeting", "Hey Sam, can we move it?"),
    "Hey Sam, can we move it?"
  );
});

test("a workspace that keeps AI processing on the device gets no cloud rewrite", async (t) => {
  const { managedPolicy } = require("./harness/policyFixtures");
  const { dictate, usePolicyStore, cleanupRequests } = await loadCleanupManager(t);
  usePolicyStore.setState({
    status: "managed",
    managed: true,
    appVersion: "1.12.0",
    policy: managedPolicy({ llm: { allowedModes: ["local"], allowedLocalModels: ["test-model"] } }),
    accountId: "account",
    authGeneration: 1,
  });

  assert.notEqual(await dictate(VERBATIM, CLEANED), CLEANED);
  assert.equal(cleanupRequests.includes(CLEANED), false);
});

test("a rewrite of a transcript that recited the dictionary is not used", async (t) => {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-assemblyai-dictation-echo-",
    settingsKey: "__assemblyAiDictationEchoSettings",
  });
  loaded.setSettings({
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionProvider: "assemblyai",
    cloudTranscriptionModel: "dictation",
    transcriptionMode: "providers",
    assemblyaiApiKey: "aai-key",
    customDictionary: ["Piha", "OpenWhispr", "Orukeet"],
    snippets: [],
    sharedDictionaryHints: { space: [], workspace: [] },
  });
  loaded.window.electronAPI.proxyAssemblyAiTranscription = async () => ({
    text: "Move the meeting to Thursday. Piha, OpenWhispr, Orukeet",
    cleanedText: "Move the meeting to Thursday. Piha, OpenWhispr, Orukeet.",
  });
  let cleanupOptions;

  const result = await loaded
    .createManager({
      cachedApiKey: null,
      cachedApiKeyProvider: null,
      getEffectiveSttLanguage: () => "auto",
      shouldStreamTranscription: () => false,
      processTranscription: async (value, _source, _wasCancelled, options) => {
        cleanupOptions = options;
        return value;
      },
      isReasoningAvailable: async () => false,
    })
    .processWithOpenAIAPI(new Blob([new ArrayBuffer(8)], { type: "audio/webm" }), {});

  assert.equal(result.rawText, "Move the meeting to Thursday.");
  assert.deepEqual(cleanupOptions, { cleanedText: undefined });
});
