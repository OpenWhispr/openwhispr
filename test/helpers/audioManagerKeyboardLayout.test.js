const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const audioBlob = () => new Blob([new ArrayBuffer(8)], { type: "audio/webm" });

const LAYOUT = {
  uk: { ok: true, klid: "00020422", iso: "uk", layoutName: "Ukrainian (Enhanced)" },
  ru: { ok: true, klid: "00000419", iso: "ru", layoutName: "Russian" },
  divehi: { ok: true, klid: "00000465", iso: "dv", layoutName: "Divehi Phonetic" },
};

// Records the `language` field of each STT request.
function captureLanguages(t) {
  const originalFetch = globalThis.fetch;
  const languages = [];
  globalThis.fetch = async (endpoint, init) => {
    languages.push(init.body.get("language"));
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
  return languages;
}

// `replies` are handed out one per getDictationLayoutLanguage call; the last one repeats.
async function setup(t, { settings = {}, replies = [LAYOUT.uk], overrides = {} } = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-keyboard-layout-test-",
    settingsKey: "__keyboardLayoutSettings",
    settings: {
      preferredLanguage: "keyboard",
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: "openai",
      ...settings,
    },
  });
  const probeCalls = [];
  loaded.window.electronAPI.getDictationLayoutLanguage = async () => {
    probeCalls.push(true);
    return replies[Math.min(probeCalls.length - 1, replies.length - 1)];
  };
  const notices = [];
  // The real startRecording and getEffectiveSttLanguage run; the start stops at
  // the activation capture, after the layout language has been fixed.
  const manager = loaded.createManager({
    isRecordingAllowedByPolicy: () => true,
    _beginActivationCapture: async () => false,
    getTranscriptionModel: () => "gpt-4o-mini-transcribe",
    getTranscriptionEndpoint: () => OPENAI_ENDPOINT,
    getAPIKey: async () => "test-key",
    getCustomDictionaryPrompt: () => "",
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
    onLayoutLanguageNotice: (notice) => notices.push(notice),
    ...overrides,
  });
  return { ...loaded, manager, probeCalls, notices };
}

test("keyboard mode: STT language comes from the layout captured at start", async (t) => {
  const { manager } = await setup(t);
  const languages = captureLanguages(t);

  await manager.startRecording();
  const result = await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.equal(result.success, true);
  assert.deepEqual(languages, ["uk"]);
});

test("capture is read once at start; a later capture (toggle stop) does not change this dictation", async (t) => {
  const { manager, probeCalls } = await setup(t, { replies: [LAYOUT.uk, LAYOUT.ru] });
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.equal(probeCalls.length, 1);
  assert.deepEqual(languages, ["uk", "uk"]);
});

test("the next dictation starts from a fresh capture", async (t) => {
  const { manager } = await setup(t, { replies: [LAYOUT.uk, LAYOUT.ru] });
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});
  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.deepEqual(languages, ["uk", "ru"]);
});

test("an internal retry of the same start does not re-read or re-announce the layout", async (t) => {
  const { manager, probeCalls, notices } = await setup(t, {
    replies: [{ ok: false, reason: "timeout" }, LAYOUT.ru],
  });

  await manager.startRecording();
  await manager.startRecording(true, { keepLayoutLanguage: true });

  assert.equal(probeCalls.length, 1);
  assert.equal(notices.length, 1);
});

test("failed probe → language 'auto' and onLayoutLanguageNotice({kind:'undetected'}) once", async (t) => {
  const { manager, notices } = await setup(t, { replies: [{ ok: false, reason: "timeout" }] });
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.deepEqual(languages, [null]);
  assert.deepEqual(notices, [{ kind: "undetected" }]);
});

test("unsupported layout → onLayoutLanguageNotice({kind:'unsupported', layoutName})", async (t) => {
  const { manager, notices } = await setup(t, { replies: [LAYOUT.divehi] });
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.deepEqual(languages, [null]);
  assert.deepEqual(notices, [{ kind: "unsupported", layoutName: "Divehi Phonetic" }]);
});

test("a rejected probe IPC still transcribes with auto and says undetected", async (t) => {
  const { manager, window, notices } = await setup(t);
  window.electronAPI.getDictationLayoutLanguage = async () => {
    throw new Error("ipc gone");
  };
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.deepEqual(languages, [null]);
  assert.deepEqual(notices, [{ kind: "undetected" }]);
});

test("success → onLayoutLanguageNotice not called", async (t) => {
  const { manager, notices } = await setup(t);
  captureLanguages(t);

  await manager.startRecording();

  assert.deepEqual(notices, []);
});

test("translation mode ignores the layout and uses translationSourceLanguage", async (t) => {
  const { manager, probeCalls, notices } = await setup(t, {
    settings: { translationSourceLanguage: "de" },
    overrides: { translationRequested: true },
  });
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.equal(probeCalls.length, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(languages, ["de"]);
});

test("non-keyboard preferredLanguage does not call getDictationLayoutLanguage", async (t) => {
  const { manager, probeCalls, notices } = await setup(t, {
    settings: { preferredLanguage: "ru" },
  });
  const languages = captureLanguages(t);

  await manager.startRecording();
  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.equal(probeCalls.length, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(languages, ["ru"]);
});

test("outside a dictation 'keyboard' reads as auto", async (t) => {
  const { manager, probeCalls } = await setup(t);
  const languages = captureLanguages(t);

  await manager.processWithOpenAIAPI(audioBlob(), {});

  assert.equal(probeCalls.length, 0);
  assert.deepEqual(languages, [null]);
});
