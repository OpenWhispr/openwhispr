const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// OpenRouter's multipart /audio/transcriptions "accepts but ignores" `prompt`
// (guides/overview/multimodal/stt), so a dictionary sent there reaches no model.
// Its tab and a Custom endpoint on its host must behave the same.
const OPENROUTER_SETUPS = {
  "OpenRouter tab": {
    cloudTranscriptionProvider: "openrouter",
    cloudTranscriptionModel: "openai/gpt-transcribe",
    openrouterApiKey: "sk-or-openrouter",
  },
  "Custom endpoint on OpenRouter": {
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://openrouter.ai/api/v1",
    cloudTranscriptionModel: "openai/gpt-transcribe",
    customTranscriptionApiKey: "sk-or-custom",
  },
};
// A provider that does read the prompt, as the control.
const OPENAI_SETUP = {
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
  openaiApiKey: "sk-openai",
};

const settingsFor = (setup) => ({
  useLocalWhisper: false,
  transcriptionMode: "providers",
  remoteTranscriptionUrl: "",
  cloudTranscriptionMode: "byok",
  allowLocalFallback: false,
  preferredLanguage: "en",
  customDictionary: ["OpenWhispr"],
  ...setup,
});

// Answers every transcription request with `text`; keeps each form body.
function replyWith(t, text) {
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return bodies;
}

async function setup(t, cachePrefix) {
  const loaded = await loadAudioManager(t, {
    cachePrefix,
    settingsKey: "__openRouterDictionarySettings",
  });
  const manager = loaded.createManager({
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
  const dictate = () =>
    manager.processWithOpenAIAPI(new Blob([new Uint8Array(1600)], { type: "audio/webm" }), {
      durationSeconds: 1,
    });
  return { setSettings: loaded.setSettings, dictate };
}

test("dictation keeps the dictionary off OpenRouter, which would drop it", async (t) => {
  const { setSettings, dictate } = await setup(t, "openwhispr-openrouter-dictionary-sent-");
  const bodies = replyWith(t, "Ship it tonight.");

  for (const [name, openRouter] of Object.entries(OPENROUTER_SETUPS)) {
    setSettings(settingsFor(openRouter));
    await dictate();
    assert.equal(bodies.at(-1).get("prompt"), null, `${name}: no prompt`);
    assert.deepEqual(bodies.at(-1).getAll("keywords[]"), [], `${name}: no keywords`);
  }

  setSettings(settingsFor(OPENAI_SETUP));
  await dictate();
  assert.equal(bodies.at(-1).get("prompt"), "OpenWhispr", "OpenAI still gets the dictionary");
});

// "OpenWhispr." is the whole dictionary read back. From a model that saw the
// dictionary that is the Whisper echo pathology and is discarded; OpenRouter
// never saw it, so it is simply what the user said.
test("a dictation made of dictionary words survives on OpenRouter", async (t) => {
  const { setSettings, dictate } = await setup(t, "openwhispr-openrouter-dictionary-echo-");
  replyWith(t, "OpenWhispr.");

  for (const [name, openRouter] of Object.entries(OPENROUTER_SETUPS)) {
    setSettings(settingsFor(openRouter));
    const result = await dictate();
    assert.equal(result.success, true, name);
    assert.equal(result.rawText, "OpenWhispr.", name);
  }

  setSettings(settingsFor(OPENAI_SETUP));
  await assert.rejects(dictate(), { code: "DICTIONARY_ECHO" });
});
