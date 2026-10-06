const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The PCM tap's WAV is what the local engine decodes; the WebM keeps being the
// recording of record for history and cloud fallbacks, so it must stay untouched.

async function loadManager(t) {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-raw-wav-test-",
    settingsKey: "__rawWavSettings",
  });
  setSettings({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "orukeet-v0.1.0",
    preferredLanguage: "en",
    customDictionary: [],
  });
  const sent = [];
  window.electronAPI.transcribeLocalParakeet = async (buffer) => {
    sent.push(Array.from(new Uint8Array(buffer)));
    return { success: true, text: "hi" };
  };
  window.electronAPI.transcribeLocalWhisper = window.electronAPI.transcribeLocalParakeet;
  const manager = createManager({ processTranscription: async (text) => text });
  return { manager, sent };
}

const webm = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const wav = () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });

test("the PCM tap's WAV goes to Parakeet instead of the WebM", async (t) => {
  const { manager, sent } = await loadManager(t);

  const result = await manager.processWithLocalParakeet(webm(), "orukeet-v0.1.0", {
    rawWav: wav(),
  });

  assert.equal(result.text, "hi");
  assert.deepEqual(sent, [[82, 73, 70, 70]]);
});

test("the PCM tap's WAV goes to whisper.cpp instead of the WebM", async (t) => {
  const { manager, sent } = await loadManager(t);

  await manager.processWithLocalWhisper(webm(), "base", { rawWav: wav() });

  assert.deepEqual(sent, [[82, 73, 70, 70]]);
});

test("without a tap the WebM is sent as before", async (t) => {
  const { manager, sent } = await loadManager(t);

  await manager.processWithLocalParakeet(webm(), "orukeet-v0.1.0", {});

  assert.deepEqual(sent, [[1, 2, 3]]);
});

async function loadFallbackManager(t, transcribeKey) {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-raw-wav-fallback-test-",
    settingsKey: "__rawWavFallbackSettings",
  });
  setSettings({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "orukeet-v0.1.0",
    preferredLanguage: "en",
    customDictionary: [],
    allowOpenAIFallback: true,
    cloudTranscriptionProvider: "openai",
  });
  window.electronAPI[transcribeKey] = async () => ({ success: false, message: "engine down" });
  let uploaded = null;
  const manager = createManager({
    processWithOpenAIAPI: async (blob) => {
      uploaded = blob;
      return { success: true, text: "cloud" };
    },
  });
  return { manager, uploaded: () => uploaded };
}

test("a failed Parakeet decode falls back to the cloud with the WebM, never the WAV", async (t) => {
  const { manager, uploaded } = await loadFallbackManager(t, "transcribeLocalParakeet");

  const result = await manager.processWithLocalParakeet(webm(), "orukeet-v0.1.0", {
    rawWav: wav(),
  });

  assert.equal(result.source, "openai-fallback");
  assert.equal(uploaded().type, "audio/webm");
});

test("a failed whisper decode falls back to the cloud with the WebM, never the WAV", async (t) => {
  const { manager, uploaded } = await loadFallbackManager(t, "transcribeLocalWhisper");

  const result = await manager.processWithLocalWhisper(webm(), "base", { rawWav: wav() });

  assert.equal(result.source, "openai-fallback");
  assert.equal(uploaded().type, "audio/webm");
});
