const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// audioManager pulls in the whole renderer graph, so every test here needs the
// same store/service stubs. `settingsKey` names the globalThis slot each test
// swaps its settings through, keeping the module cache per-test isolated.
async function loadAudioManager(t, { cachePrefix, settingsKey }) {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix,
    mockModules: {
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.${settingsKey};
        export const getEffectiveCleanupModel = () => null;
        export const isCloudCleanupMode = () => false;
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => false;
      `,
      "/services/ReasoningService": "export default class ReasoningService {};",
      "/services/SyncService.js": "export const syncService = {};",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
    },
  });
  t.after(() => {
    delete globalThis[settingsKey];
  });

  const AudioManager = (await vite.ssrLoadModule("/helpers/audioManager.js")).default;
  return {
    window,
    vite,
    setSettings: (settings) => {
      globalThis[settingsKey] = settings;
    },
    // Prototype-only instance: the constructor wires up media devices we don't need.
    createManager: (overrides = {}) =>
      Object.assign(Object.create(AudioManager.prototype), {
        getEffectiveSttLanguage: () => "auto",
        getTranscriptionModel: () => "whisper-1",
        getAPIKey: async () => "test-key",
        getWhisperPrompt: () => null,
        getKeyterms: () => [],
        shouldStreamTranscription: () => false,
        isDictionaryEcho: () => false,
        processTranscription: async (text) => text,
        isReasoningAvailable: async () => false,
        ...overrides,
      }),
  };
}

// Captures the prompt field each transcription request actually sent.
function capturePrompts(t) {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (endpoint, init) => {
    prompts.push(init.body.get("prompt"));
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
  return prompts;
}

// A ~100-term custom dictionary joined the way getCustomDictionaryPrompt does,
// mirroring the 1633-char report in #CUS-49 (1633 -> 899 at maxChars 900).
function buildLongDictionaryPrompt(count = 100) {
  const words = [];
  for (let i = 0; i < count; i++) {
    words.push(`SpecializedTerm${String(i).padStart(3, "0")}`);
  }
  return words.join(", ");
}

test("custom dictionary prompt caps follow the provider's real limit", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-dictionary-prompt-cap-test-",
    settingsKey: "__dictionaryPromptCapSettings",
  });

  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  const longPrompt = buildLongDictionaryPrompt();
  assert.ok(longPrompt.length > 1600, "fixture must exceed the historical 900-char cap");

  await t.test("gpt-4o-mini-transcribe sends the dictionary whole", async () => {
    setSettings({
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "openai",
    });
    const prompts = capturePrompts(t);
    const manager = createManager({
      getTranscriptionModel: () => "gpt-4o-mini-transcribe",
      getTranscriptionEndpoint: () => "https://api.openai.com/v1/audio/transcriptions",
      getWhisperPrompt: () => longPrompt,
    });

    const result = await manager.processWithOpenAIAPI(audioBlob, {});
    assert.equal(result.success, true);
    assert.equal(prompts.length, 1);
    assert.equal(
      prompts[0],
      longPrompt,
      "16k-context transcribe models must not lose dictionary words to the Groq-era cap"
    );
  });

  await t.test("groq stays under its documented 896-char limit", async () => {
    setSettings({
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "groq",
    });
    const prompts = capturePrompts(t);
    const manager = createManager({
      getTranscriptionModel: () => "whisper-large-v3-turbo",
      getTranscriptionEndpoint: () => "https://api.groq.com/openai/v1/audio/transcriptions",
      getWhisperPrompt: () => longPrompt,
    });

    await manager.processWithOpenAIAPI(audioBlob, {});
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].length <= 890, `groq prompt must stay capped, got ${prompts[0].length}`);
    assert.ok(longPrompt.startsWith(prompts[0]), "truncation must keep the head of the list");
    assert.equal(
      longPrompt[prompts[0].length],
      ",",
      "truncation must end on a whole dictionary entry"
    );
  });

  await t.test("whisper-1 keeps the ~224-token (900-char) cap", async () => {
    setSettings({
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "openai",
    });
    const prompts = capturePrompts(t);
    const manager = createManager({
      getTranscriptionModel: () => "whisper-1",
      getTranscriptionEndpoint: () => "https://api.openai.com/v1/audio/transcriptions",
      getWhisperPrompt: () => longPrompt,
    });

    await manager.processWithOpenAIAPI(audioBlob, {});
    assert.equal(prompts.length, 1);
    assert.ok(
      prompts[0].length <= 900,
      `whisper-1 prompt must stay capped, got ${prompts[0].length}`
    );
    assert.ok(longPrompt.startsWith(prompts[0]), "truncation must keep the head of the list");
  });

  await t.test("4o transcribe still gets a context guard on absurd lists", async () => {
    setSettings({
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "openai",
    });
    const hugePrompt = buildLongDictionaryPrompt(700); // ~13k chars
    assert.ok(hugePrompt.length > 12000);
    const prompts = capturePrompts(t);
    const manager = createManager({
      getTranscriptionModel: () => "gpt-4o-transcribe",
      getTranscriptionEndpoint: () => "https://api.openai.com/v1/audio/transcriptions",
      getWhisperPrompt: () => hugePrompt,
    });

    await manager.processWithOpenAIAPI(audioBlob, {});
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].length <= 8000, `4o guard must hold, got ${prompts[0].length}`);
    assert.ok(prompts[0].length > 7000, "guard must be generous, not the Groq-era 900");
    assert.ok(hugePrompt.startsWith(prompts[0]), "truncation must keep the head of the list");
  });
});

test("local whisper gets the head of a long dictionary, not whisper.cpp's tail", async (t) => {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-dictionary-prompt-cap-local-test-",
    settingsKey: "__dictionaryPromptCapLocalSettings",
  });
  setSettings({ useLocalWhisper: true, localTranscriptionProvider: "whisper" });

  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  const longPrompt = buildLongDictionaryPrompt();
  const seen = [];
  window.electronAPI.transcribeLocalWhisper = async (_buf, options) => {
    seen.push(options.initialPrompt);
    return { success: true, text: "transcribed text" };
  };
  const manager = createManager({ getWhisperPrompt: () => longPrompt });

  const result = await manager.processWithLocalWhisper(audioBlob, "base", {});
  assert.equal(result.success, true);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].length <= 900, `local prompt must stay capped, got ${seen[0].length}`);
  assert.ok(longPrompt.startsWith(seen[0]), "truncation must keep the head of the list");
  assert.equal(longPrompt[seen[0].length], ",", "truncation must end on a whole entry");
});
