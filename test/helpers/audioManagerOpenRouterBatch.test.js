const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// OpenRouter shares OpenAI's multipart path, so a slip in key selection would
// send the user's OpenAI key to openrouter.ai; pin both the host and the key.
test("OpenRouter dictation posts to OpenRouter with the OpenRouter key", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-openrouter-batch-test-",
    settingsKey: "__openRouterBatchSettings",
    settings: {
      useLocalWhisper: false,
      transcriptionMode: "providers",
      remoteTranscriptionUrl: "",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "openrouter",
      cloudTranscriptionModel: "openai/gpt-transcribe",
      openrouterApiKey: "sk-or-openrouter",
      openaiApiKey: "sk-openai",
      allowLocalFallback: false,
      preferredLanguage: "en",
      customDictionary: [],
    },
  });
  window.electronAPI.getOpenAIKey = async () => {
    throw new Error("must not read the OpenAI key");
  };

  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ text: "hello" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const manager = createManager({
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
  const result = await manager.processWithOpenAIAPI(
    new Blob([new Uint8Array(1600)], { type: "audio/webm" }),
    { durationSeconds: 1 }
  );

  assert.equal(result.success, true);
  assert.deepEqual(requests, [
    {
      url: "https://openrouter.ai/api/v1/audio/transcriptions",
      headers: { Authorization: "Bearer sk-or-openrouter" },
    },
  ]);
});
