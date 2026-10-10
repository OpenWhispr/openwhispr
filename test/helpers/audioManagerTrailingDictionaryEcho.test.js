const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// #2581 through the OpenAI-compatible batch path: the server recites the
// dictionary prompt after the real speech, and the recited tail must not reach
// the saved transcript.

function respondWith(t, text) {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (endpoint, init) => {
    prompts.push(init.body.get("prompt"));
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ text }),
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return prompts;
}

test("OpenAI-compatible transcription drops a dictionary list recited after the speech", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-trailing-dictionary-echo-test-",
    settingsKey: "__trailingDictionaryEchoSettings",
  });
  // The prompt is built by the real getCustomDictionaryPrompt/getWhisperPrompt
  // from these settings, snippet triggers included.
  const useDictionary = (customDictionary, snippets = []) =>
    setSettings({
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "openai",
      customDictionary,
      snippets,
    });
  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  const makeManager = (dictionary, model = "whisper-1", snippets = []) => {
    useDictionary(dictionary, snippets);
    return createManager({
      getEffectiveSttLanguage: () => "auto",
      getTranscriptionModel: () => model,
      getTranscriptionEndpoint: () => "https://stt.example.test/v1/audio/transcriptions",
      getAPIKey: async () => "test-key",
      getKeyterms: () => [],
      shouldStreamTranscription: () => false,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
    });
  };

  await t.test("the recited tail is removed from text and rawText", async () => {
    respondWith(t, "Appreciate the time. Thanks, all. Thanks, you. OpenWhispr, n8n.");

    const result = await makeManager(["OpenWhispr", "n8n"]).processWithOpenAIAPI(audioBlob, {});

    assert.equal(result.success, true);
    assert.equal(result.rawText, "Appreciate the time. Thanks, all. Thanks, you.");
    assert.equal(result.text, "Appreciate the time. Thanks, all. Thanks, you.");
  });

  await t.test("a whole-response echo is still discarded as before", async () => {
    respondWith(t, "OpenWhispr, n8n.");

    await assert.rejects(makeManager(["OpenWhispr", "n8n"]).processWithOpenAIAPI(audioBlob, {}), {
      code: "DICTIONARY_ECHO",
    });
  });

  await t.test("only terms the capped prompt carried count as an echo", async (t) => {
    const terms = Array.from(
      { length: 100 },
      (_, i) => `SpecializedTerm${String(i).padStart(3, "0")}`
    );
    const prompts = respondWith(t, "We shipped it. SpecializedTerm098, SpecializedTerm099.");

    const result = await makeManager(terms).processWithOpenAIAPI(audioBlob, {});

    assert.ok(!prompts[0].includes("SpecializedTerm098"), "fixture must cap the prompt");
    assert.equal(result.rawText, "We shipped it. SpecializedTerm098, SpecializedTerm099.");
  });

  await t.test("a snippet trigger said as its own sentence is kept", async () => {
    respondWith(t, "Text him. On my way, see you.");
    const manager = makeManager(["OpenWhispr", "n8n"], "whisper-1", [
      { trigger: "on my way, see you", replacement: "On my way, see you soon!" },
    ]);

    const result = await manager.processWithOpenAIAPI(audioBlob, {});

    assert.equal(result.rawText, "Text him. On my way, see you.");
  });

  await t.test("gpt-transcribe compares against the terms it sent as keywords[]", async (t) => {
    const prompts = respondWith(t, "Appreciate the time. Thanks, you. OpenWhispr, n8n.");

    const result = await makeManager(["OpenWhispr", "n8n"], "gpt-transcribe").processWithOpenAIAPI(
      audioBlob,
      {}
    );

    assert.equal(prompts[0], null, "the dictionary must ride keywords[], not the prompt");
    assert.equal(result.rawText, "Appreciate the time. Thanks, you.");
  });

  await t.test("a model that is sent no prompt keeps its whole transcript", async () => {
    const prompts = respondWith(t, "Thanks, you. OpenWhispr, n8n.");

    const result = await makeManager(["OpenWhispr", "n8n"], "orukeet-v0.1.0").processWithOpenAIAPI(
      audioBlob,
      {}
    );

    assert.equal(prompts[0], null);
    assert.equal(result.rawText, "Thanks, you. OpenWhispr, n8n.");
  });
});
