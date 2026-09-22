const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const DICTIONARY = "OpenWhispr, Gizmo Labs";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

// Captures the dictionary-bearing fields of each transcription request.
function captureRequests(t) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (endpoint, init) => {
    requests.push({
      prompt: init.body.get("prompt"),
      keywords: init.body.getAll("keywords[]"),
      stream: init.body.get("stream"),
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ text: "transcribed text" }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requests;
}

test("the custom dictionary rides gpt-transcribe's keywords[] channel, legacy models' prompt", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-transcription-keywords-test-",
    settingsKey: "__transcriptionKeywordsSettings",
  });
  setSettings({
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionProvider: "openai",
  });
  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  // getWhisperPrompt and shouldStreamTranscription are the real prototype methods.
  const manager = (model, overrides = {}) =>
    createManager({
      getEffectiveSttLanguage: () => "auto",
      getTranscriptionModel: () => model,
      getTranscriptionEndpoint: () => OPENAI_ENDPOINT,
      getAPIKey: async () => "test-key",
      getCustomDictionaryPrompt: () => DICTIONARY,
      getKeyterms: () => [],
      isDictionaryEcho: () => false,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
      ...overrides,
    });

  await t.test("gpt-transcribe sends one keywords[] entry per term and no prompt", async () => {
    const requests = captureRequests(t);
    const result = await manager("gpt-transcribe").processWithOpenAIAPI(audioBlob, {});
    assert.equal(result.success, true);
    assert.deepEqual(requests, [
      { prompt: null, keywords: ["OpenWhispr", "Gizmo Labs"], stream: "true" },
    ]);
  });

  await t.test(
    "a Chinese script bias still travels in the prompt beside the keywords",
    async () => {
      const requests = captureRequests(t);
      await manager("gpt-transcribe", {
        getEffectiveSttLanguage: () => "zh-TW",
      }).processWithOpenAIAPI(audioBlob, {});
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].keywords, ["OpenWhispr", "Gizmo Labs"]);
      assert.match(requests[0].prompt, /繁體中文/);
      assert.doesNotMatch(requests[0].prompt, /OpenWhispr/, "dictionary must not be sent twice");
    }
  );

  await t.test("gpt-4o-mini-transcribe keeps the comma-joined prompt", async () => {
    const requests = captureRequests(t);
    await manager("gpt-4o-mini-transcribe").processWithOpenAIAPI(audioBlob, {});
    assert.deepEqual(requests, [{ prompt: DICTIONARY, keywords: [], stream: "true" }]);
  });

  await t.test("whisper-1 keeps the prompt and never streams", async () => {
    const requests = captureRequests(t);
    await manager("whisper-1").processWithOpenAIAPI(audioBlob, {});
    assert.deepEqual(requests, [{ prompt: DICTIONARY, keywords: [], stream: null }]);
  });
});
