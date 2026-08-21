const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const AUDIO = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const BASE_SETTINGS = {
  preferredLanguage: "en",
  customDictionary: ["Qdrant", "OpenAI"],
  snippets: [],
  chineseScriptPreference: "auto",
  useCleanupModel: false,
  cleanupCloudMode: "byok",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  allowOpenAIFallback: false,
  allowLocalFallback: false,
  fallbackWhisperModel: "base",
};

async function createDictionaryEchoHarness(t, name, settings = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: `openwhispr-dictionary-echo-${name}-test-`,
    settingsKey: `__dictionaryEcho${name}Settings`,
    settings: { ...BASE_SETTINGS, ...settings },
  });
  return {
    ...loaded,
    manager: loaded.createManager({
      voiceAgentRequested: false,
      translationRequested: false,
      getEffectiveSttLanguage: () => "en",
      getTranscriptionModel: () => "whisper-1",
      getAPIKey: async () => "test-key",
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
      finalizeChineseScript: async (text) => text,
    }),
  };
}

async function assertDictionaryEcho(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.message, "No audio detected");
    assert.equal(error.code, "DICTIONARY_ECHO");
    return true;
  });
}

test("a genuine transcription failure still reports an error and saves the recording", async (t) => {
  const { createManager } = await createDictionaryEchoHarness(t, "Failure", {
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
  });
  const errors = [];
  const saved = [];
  const manager = createManager({
    isProcessing: true,
    _localSpeechGateState: null,
    pendingAssistantConversation: null,
    pendingSelectionEdit: null,
    lastAudioBlob: AUDIO,
    processWithLocalWhisper: async () => {
      throw new Error("Groq returned 500");
    },
    onStateChange() {},
    onError: (error) => errors.push(error),
    saveFailedTranscription: (message, code) => saved.push({ message, code }),
  });

  await manager.processAudio(AUDIO);

  assert.equal(errors.length, 1);
  assert.match(errors[0].description, /Groq returned 500/);
  assert.deepEqual(saved, [{ message: "Groq returned 500", code: null }]);
});

test("local Whisper preserves dictionary-echo tagging after its prompt-free retry", async (t) => {
  const { window, manager } = await createDictionaryEchoHarness(t, "Local", {
    useLocalWhisper: true,
  });
  const calls = [];
  window.electronAPI.transcribeLocalWhisper = async (_audio, options) => {
    calls.push(options);
    return { success: true, text: "Qdrant OpenAI" };
  };

  await assertDictionaryEcho(manager.processWithLocalWhisper(AUDIO, "base"));

  assert.equal(calls.length, 2);
  assert.equal(calls[1].skipVad, true);
  assert.equal(calls[1].initialPrompt, undefined);
});

test("OpenWhispr cloud preserves dictionary-echo tagging", async (t) => {
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { ...originalNavigator, onLine: true },
  });
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  });
  const { window, manager } = await createDictionaryEchoHarness(t, "Cloud");
  window.electronAPI.cloudTranscribe = async () => ({
    success: true,
    text: "Qdrant OpenAI",
  });

  await assertDictionaryEcho(manager.processWithOpenWhisprCloud(AUDIO));
});

test("proxied BYOK providers preserve dictionary-echo tagging", async (t) => {
  const { window, manager } = await createDictionaryEchoHarness(t, "Proxy", {
    useLocalWhisper: false,
    cloudTranscriptionProvider: "corti",
  });
  window.electronAPI.proxyCortiTranscription = async () => ({ text: "Qdrant OpenAI" });

  await assertDictionaryEcho(manager.processWithOpenAIAPI(AUDIO));
});

test("renderer-fetch BYOK providers preserve dictionary-echo tagging", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify({ text: "Qdrant OpenAI" }),
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const { manager } = await createDictionaryEchoHarness(t, "Fetch", {
    useLocalWhisper: false,
    cloudTranscriptionProvider: "openai",
  });
  manager.getTranscriptionEndpoint = () => "https://api.openai.com/v1/audio/transcriptions";
  manager.shouldStreamTranscription = () => false;

  await assertDictionaryEcho(manager.processWithOpenAIAPI(AUDIO));
});
