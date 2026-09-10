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
