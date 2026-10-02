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

// OpenRouter's documented reply when an account's prepaid credit is spent.
const OUT_OF_CREDITS_BODY = JSON.stringify({
  error: {
    code: 402,
    message: "Insufficient credits. Add more using https://openrouter.ai/credits",
  },
});

// The dictation error card showed OpenRouter's raw JSON as its text; it must
// read as a translated out-of-credits message, from either OpenRouter setup.
test("an OpenRouter 402 shows a translated out-of-credits card, not its JSON", async (t) => {
  const setups = {
    "OpenRouter tab": {
      cloudTranscriptionProvider: "openrouter",
      cloudTranscriptionModel: "openai/gpt-transcribe",
      openrouterApiKey: "sk-or-openrouter",
    },
    "Custom endpoint": {
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://openrouter.ai/api/v1",
      cloudTranscriptionModel: "openai/gpt-transcribe",
      customTranscriptionApiKey: "sk-or-custom",
    },
  };
  const { createManager, setSettings, vite } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-openrouter-credits-test-",
    settingsKey: "__openRouterCreditsSettings",
  });
  const { transcriptionFailureOutcome } = await vite.ssrLoadModule(
    "/helpers/transcriptionFailureOutcome.js"
  );
  const { getRecordingErrorTitle, getRecordingErrorDescription } = await vite.ssrLoadModule(
    "/utils/recordingErrors.ts"
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(OUT_OF_CREDITS_BODY, {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  for (const [name, setup] of Object.entries(setups)) {
    setSettings({
      useLocalWhisper: false,
      transcriptionMode: "providers",
      remoteTranscriptionUrl: "",
      cloudTranscriptionMode: "byok",
      allowLocalFallback: false,
      preferredLanguage: "en",
      customDictionary: [],
      ...setup,
    });
    const manager = createManager({
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
    });
    const error = await manager
      .processWithOpenAIAPI(new Blob([new Uint8Array(1600)], { type: "audio/webm" }), {
        durationSeconds: 1,
      })
      .then(
        () => assert.fail(`${name}: a 402 must not succeed`),
        (err) => err
      );

    const { report } = transcriptionFailureOutcome(error);
    const translate = (key) => `t(${key})`;
    assert.equal(
      getRecordingErrorTitle(report, translate),
      "t(hooks.audioRecording.errorTitles.outOfCredits)",
      name
    );
    assert.equal(
      getRecordingErrorDescription(report, translate),
      "t(hooks.audioRecording.errorDescriptions.openRouterOutOfCredits)",
      name
    );
  }
});
