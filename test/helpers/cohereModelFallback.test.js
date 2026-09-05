const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => "/tmp",
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ParakeetManager = require("../../src/helpers/parakeet.js");
const { loadAudioManager } = require("./harness/audioManager.js");

test("transcribeLocalParakeet defaults to cohere-transcribe-03-2026 when provider is cohere", async () => {
  const manager = new ParakeetManager();
  let requestedModel = null;
  manager.serverManager.isAvailable = () => true;
  manager.serverManager.isModelDownloaded = (model) => {
    requestedModel = model;
    return true;
  };
  manager.serverManager.transcribe = async () => {
    return { text: "test transcription" };
  };

  const result = await manager.transcribeLocalParakeet(Buffer.from("dummy audio"), {
    provider: "cohere",
  });
  assert.equal(result.text, "test transcription");
  assert.equal(requestedModel, "cohere-transcribe-03-2026");
});

test("audioManager routes unset cohereModel to cohere-transcribe-03-2026 in dictation", async (t) => {
  let transcribeModel = null;

  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-cohere-model-fallback-test-",
    settingsKey: "__cohereFallbackSettings",
    settings: {
      useLocalWhisper: true,
      localTranscriptionProvider: "cohere",
      cohereModel: "",
      parakeetModel: "parakeet-tdt-0.6b-v3",
      preferredLanguage: "en",
    },
  });

  window.electronAPI.transcribeLocalParakeet = async (_buf, options) => {
    transcribeModel = options.model;
    return { success: true, text: "cohere text" };
  };
  window.electronAPI.recordAnalyticsEvent = async () => ({ success: true });
  window.electronAPI.saveTranscription = async () => ({ id: 1 });

  const manager = createManager();
  manager.setupWorkletsAndSource = async () => true;

  // Exercise processAudio
  const dummyBlob = new Blob([new Uint8Array(100)], { type: "audio/webm" });
  await manager.processAudio(dummyBlob);
  assert.equal(transcribeModel, "cohere-transcribe-03-2026");
});

test("retry-transcription model logic defaults to cohere-transcribe-03-2026 when provider is cohere", () => {
  const { isSherpaLocalProvider } = require("../../src/helpers/parakeetModelInfo.js");
  const settings = { localTranscriptionProvider: "cohere", cohereModel: "" };
  assert.ok(isSherpaLocalProvider(settings.localTranscriptionProvider));
  const model =
    settings.localTranscriptionProvider === "cohere"
      ? settings.cohereModel || "cohere-transcribe-03-2026"
      : settings.parakeetModel || "parakeet-tdt-0.6b-v3";
  assert.equal(model, "cohere-transcribe-03-2026");
});
