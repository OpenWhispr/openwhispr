const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const settings = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  useCleanupModel: true,
  customDictionary: [],
};

async function load(t) {
  return loadAudioManager(t, {
    cachePrefix: "openwhispr-continuous-segment-",
    settingsKey: "__continuousSegmentSettings",
    settings,
  });
}

test("a continuous phrase is transcribed on the user's engine without cleanup", async (t) => {
  const { window, createManager } = await load(t);
  const calls = [];
  window.electronAPI = {
    transcribeLocalWhisper: async (buffer, options) => {
      calls.push({ bytes: buffer.byteLength, model: options.model });
      return { success: true, text: "hey assistant draft an email" };
    },
  };
  let reasoningChecks = 0;
  const manager = createManager({
    _rawTranscriptionDepth: 0,
    isReasoningAvailable: async () => {
      reasoningChecks += 1;
      return true;
    },
    getCustomDictionaryPrompt: () => "",
    getWhisperPrompt: () => "",
    getEffectiveSttLanguage: () => "en",
    finalizeChineseScript: (text) => text,
  });

  const wav = new Blob([new Uint8Array(64)], { type: "audio/wav" });
  const result = await manager.transcribeContinuousSegment(wav, { durationSeconds: 1 });

  assert.deepEqual(result, {
    text: "hey assistant draft an email",
    rawText: "hey assistant draft an email",
  });
  assert.deepEqual(calls, [{ bytes: 64, model: "base" }]);
  assert.equal(reasoningChecks, 0, "cleanup and wake-word routing never run");
  assert.equal(manager._rawTranscriptionDepth, 0);
});

test("a continuous phrase heard as silence is empty rather than an error", async (t) => {
  const { window, createManager } = await load(t);
  window.electronAPI = {
    transcribeLocalWhisper: async () => ({ success: false, message: "No audio detected" }),
  };
  const manager = createManager({
    _rawTranscriptionDepth: 0,
    getCustomDictionaryPrompt: () => "",
    getWhisperPrompt: () => "",
    getEffectiveSttLanguage: () => "en",
  });

  const wav = new Blob([new Uint8Array(64)], { type: "audio/wav" });
  assert.deepEqual(await manager.transcribeContinuousSegment(wav, { durationSeconds: 1 }), {
    text: "",
  });
  assert.equal(manager._rawTranscriptionDepth, 0);
});
