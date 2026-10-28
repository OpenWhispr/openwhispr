const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// Managed dictation over the upload limit is chunked in main; a lost chunk
// comes back as a warning the dictation pill must still surface.
test("managed dictation keeps main's partial-transcript warning and names the real provider", async (t) => {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-managed-dictation-test-",
    settingsKey: "__managedDictationSettings",
    settings: { useLocalWhisper: false, allowLocalFallback: false },
    mockModules: {
      "/services/managedTranscription.ts": `
        export const isManagedTranscriptionActive = () => true;
        export const getManagedTranscriptionResolution = () => ({
          kind: "managed",
          provider: "openai-compatible",
          deployment: "company-batch",
          context: {},
        });
      `,
    },
  });
  const requests = [];
  loaded.window.electronAPI.managedTranscribe = async (payload) => {
    requests.push(payload);
    return { text: "part one part three", warning: "1 audio chunks failed" };
  };
  const manager = loaded.createManager({
    isProcessing: true,
    _activeTranscriptionAbortController: null,
    getEffectiveSttLanguage: () => "auto",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });

  const result = await manager.processWithOpenAIAPI(
    new Blob(["recording"], { type: "audio/webm" })
  );

  assert.equal(requests[0].managed.provider, "openai-compatible");
  assert.equal(result.text, "part one part three");
  assert.equal(result.warning, "1 audio chunks failed");
  assert.equal(result.source, "openai-compatible-managed");
});
