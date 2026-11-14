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
    customDictionary: ["Piha"],
    snippets: [],
    sharedDictionaryHints: { space: [], workspace: [] },
  });
  const payloads = [];
  loaded.window.electronAPI.proxyAssemblyAiTranscription = async (payload) => {
    payloads.push(payload);
    return { text: VERBATIM, cleanedText: CLEANED };
  };
  let cleanupOptions;

  const result = await loaded
    .createManager({
      getEffectiveSttLanguage: () => "auto",
      getTranscriptionModel: () => "dictation",
      getAPIKey: async () => "test-key",
      shouldStreamTranscription: () => false,
      processTranscription: async (value, _source, _wasCancelled, options) => {
        cleanupOptions = options;
        return options.cleanedText;
      },
      isReasoningAvailable: async () => false,
    })
    .processWithOpenAIAPI(new Blob([new ArrayBuffer(8)], { type: "audio/webm" }), {});

  assert.equal(payloads.length, 1);
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
    manager,
    dictate,
    cleanupRequests,
    setSettings: (next) => useSettingsStore.setState(next),
  };
}

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
