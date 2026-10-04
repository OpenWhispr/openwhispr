const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// A realtime-only BYOK provider reaches the batch path only when streaming was
// skipped (no key) — the route guard must speak first, because the key read
// that used to run ahead of it falls into the OpenAI branch and blames a key
// the provider never uses.

async function loadManager(t) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-batch-route-guard-test-",
    settingsKey: "__batchRouteGuardSettings",
  });
  return createManager();
}

function setSettings(overrides = {}) {
  globalThis.__batchRouteGuardSettings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "deepgram",
    cloudTranscriptionModel: "nova-3",
    deepgramApiKey: "",
    openaiApiKey: "",
    allowLocalFallback: false,
    preferredLanguage: "en",
    customDictionary: [],
    ...overrides,
  };
}

const audioBlob = () => new Blob([new Uint8Array(1600)], { type: "audio/webm" });

test("batch dictation on a keyless realtime-only provider reports the missing key, not OpenAI's", async (t) => {
  const manager = await loadManager(t);
  setSettings();
  let openAiKeyReads = 0;
  globalThis.window.electronAPI.getOpenAIKey = async () => {
    openAiKeyReads += 1;
    return "";
  };

  await assert.rejects(manager.processWithOpenAIAPI(audioBlob()), (error) => {
    assert.equal(error.code, "API_KEY_MISSING");
    assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.providerKeyMissing");
    assert.doesNotMatch(error.message, /OpenAI/);
    return true;
  });
  assert.equal(openAiKeyReads, 0, "the route guard runs before any key read");
});

test("batch dictation on a keyed realtime-only provider fails closed on the transport", async (t) => {
  const manager = await loadManager(t);
  setSettings({ deepgramApiKey: "dg-test" });
  globalThis.window.electronAPI.getOpenAIKey = async () => {
    throw new Error("must not read the OpenAI key");
  };

  await assert.rejects(manager.processWithOpenAIAPI(audioBlob()), (error) => {
    assert.equal(error.code, "STREAMING_ONLY_PROVIDER");
    assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.streamingOnlyProvider");
    return true;
  });
});

test("Fish dictation uses its proxy with the selected model, language and recording MIME", async (t) => {
  const manager = await loadManager(t);
  Object.assign(manager, {
    getEffectiveSttLanguage: () => "pt-BR",
    getWhisperPrompt: () => "",
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
  setSettings({
    cloudTranscriptionProvider: "fish",
    cloudTranscriptionModel: "transcribe-1",
    cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
    fishApiKey: "fish-test-key",
  });
  globalThis.window.electronAPI.getOpenAIKey = async () => {
    assert.fail("Fish dictation must not read the OpenAI key");
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.fail("Fish dictation must not use renderer HTTP");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls = [];
  globalThis.window.electronAPI.proxyFishTranscription = async (payload) => {
    calls.push(payload);
    return { text: "Olá mundo" };
  };

  for (const [mimeType, fileName] of [
    ["audio/webm;codecs=opus", "audio.webm"],
    ["audio/ogg;codecs=opus", "audio.ogg"],
    ["audio/mp4", "audio.mp4"],
    ["audio/wav", "audio.wav"],
  ]) {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: mimeType });
    const result = await manager.processWithOpenAIAPI(blob);
    assert.equal(result.success, true);
    assert.equal(result.source, "fish");
    assert.equal(result.rawText, "Olá mundo");
    const payload = calls.at(-1);
    assert.equal(payload.model, "transcribe-1");
    assert.equal(payload.language, "pt");
    assert.equal(payload.contentType, mimeType);
    assert.equal(payload.fileName, fileName);
    assert.equal(payload.apiKey, undefined, "the proxy resolves its key in main");
    assert.deepEqual(new Uint8Array(payload.audioBuffer), new Uint8Array([1, 2, 3]));
  }
  assert.equal(calls.length, 4);
});

test("Fish dictation reads its saved key when needed and fails closed when it is missing", async (t) => {
  const manager = await loadManager(t);
  setSettings({ cloudTranscriptionProvider: "fish", fishApiKey: " " });
  let fishKeyReads = 0;
  globalThis.window.electronAPI.getFishKey = async () => {
    fishKeyReads += 1;
    return "saved-fish-key";
  };
  globalThis.window.electronAPI.getOpenAIKey = async () => {
    assert.fail("Fish must not read the OpenAI key");
  };
  assert.equal(await manager.getAPIKey(), "saved-fish-key");
  assert.equal(fishKeyReads, 1);

  manager.cachedApiKey = null;
  globalThis.window.electronAPI.getFishKey = async () => "";
  await assert.rejects(manager.getAPIKey(), (error) => {
    assert.equal(error.code, "API_KEY_MISSING");
    assert.match(error.message, /Fish Audio/);
    return true;
  });
});
