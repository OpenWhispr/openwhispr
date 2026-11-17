const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// #2581 through the proxied providers: a model recites the dictionary in the
// order it was sent. Mistral's contextBias and xAI/Gemini's keyterms carry
// personal words first, Tinfoil's prompt carries them last (Whisper order), so
// each recital is recognised only against the list in its own sent order.

const SPEECH = "We agreed to ship the release on Friday after the review.";

const PROVIDERS = {
  tinfoil: "proxyTinfoilTranscription",
  mistral: "proxyMistralTranscription",
  xai: "proxyXaiTranscription",
  gemini: "proxyGeminiTranscription",
};

async function setUp(t) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-proxy-dictionary-echo-",
    settingsKey: "__proxyDictionaryEchoSettings",
  });
  const respond = (provider, text) => {
    const payloads = [];
    loaded.window.electronAPI[PROVIDERS[provider]] = async (payload) => {
      payloads.push(payload);
      return { text };
    };
    return payloads;
  };
  const transcribe = async (
    provider,
    text,
    sharedDictionaryHints = { space: ["Qdrant"], workspace: ["Zentrum"] }
  ) => {
    loaded.setSettings({
      useLocalWhisper: false,
      allowLocalFallback: false,
      cloudTranscriptionProvider: provider,
      transcriptionMode: "providers",
      customDictionary: ["Piha", "Biscuit"],
      snippets: [],
      sharedDictionaryHints,
    });
    const payloads = respond(provider, text);
    // The real getKeyterms and getWhisperPrompt build what each payload carries.
    const result = await loaded
      .createManager({
        getEffectiveSttLanguage: () => "auto",
        getTranscriptionModel: () => (provider === "mistral" ? "voxtral-mini-latest" : "model"),
        getAPIKey: async () => "test-key",
        shouldStreamTranscription: () => false,
        processTranscription: async (value) => value,
        isReasoningAvailable: async () => false,
      })
      .processWithOpenAIAPI(new Blob([new ArrayBuffer(8)], { type: "audio/webm" }), {});
    return { result, payload: payloads[0] };
  };
  return { transcribe };
}

const PERSONAL_FIRST = "Piha, Biscuit, Qdrant, Zentrum.";
const WHISPER_ORDER = "Zentrum, Qdrant, Piha, Biscuit.";

test("keyterm providers drop a recital in the personal-first order they sent", async (t) => {
  const { transcribe } = await setUp(t);

  for (const provider of ["xai", "gemini"]) {
    await t.test(provider, async () => {
      const { result, payload } = await transcribe(provider, `${SPEECH} ${PERSONAL_FIRST}`);
      assert.deepEqual(payload.keyterms, ["Piha", "Biscuit", "Qdrant", "Zentrum"]);
      assert.equal(result.success, true);
      assert.equal(result.rawText, SPEECH);
    });
  }
});

test("Mistral drops a recital in the personal-first order of its contextBias", async (t) => {
  const { transcribe } = await setUp(t);

  const { result, payload } = await transcribe("mistral", `${SPEECH} ${PERSONAL_FIRST}`);

  assert.deepEqual(payload.contextBias, ["Piha", "Biscuit", "Qdrant", "Zentrum"]);
  assert.equal(result.rawText, SPEECH);
});

test("a recital out of the sent order is left in the transcript", async (t) => {
  const { transcribe } = await setUp(t);

  // The Whisper order isn't what xAI was sent, so it isn't its recital.
  const xai = await transcribe("xai", `${SPEECH} ${WHISPER_ORDER}`);
  assert.equal(xai.result.rawText, `${SPEECH} ${WHISPER_ORDER}`);

  // Tinfoil's prompt is in Whisper order, so that is the recital it drops.
  const tinfoil = await transcribe("tinfoil", `${SPEECH} ${WHISPER_ORDER}`);
  assert.equal(tinfoil.payload.prompt, "Zentrum, Qdrant, Piha, Biscuit");
  assert.equal(tinfoil.result.rawText, SPEECH);
  const tinfoilPersonalFirst = await transcribe("tinfoil", `${SPEECH} ${PERSONAL_FIRST}`);
  assert.equal(tinfoilPersonalFirst.result.rawText, `${SPEECH} ${PERSONAL_FIRST}`);
});

test("keyterm providers treat a recital of every sent keyterm as an echo", async (t) => {
  const { transcribe } = await setUp(t);
  // More shared words than the Whisper window holds, all of them sent as keyterms.
  const hints = { space: [], workspace: Array.from({ length: 60 }, (_, i) => `Termword${i}`) };
  const recital = ["Piha", "Biscuit", ...hints.workspace].join(", ");

  for (const provider of ["xai", "gemini"]) {
    await t.test(provider, async () => {
      const { payload } = await transcribe(provider, SPEECH, hints);
      assert.equal(payload.keyterms.length, 62);
      await assert.rejects(transcribe(provider, recital, hints), /No audio detected/);
    });
  }
});

test("keyterm providers keep the personal-only echo check", async (t) => {
  const { transcribe } = await setUp(t);
  const hints = { space: [], workspace: [] };

  for (const provider of ["xai", "gemini"]) {
    await t.test(provider, async () => {
      await assert.rejects(transcribe(provider, "Piha, Biscuit.", hints), /No audio detected/);
      const speech = await transcribe(provider, `${SPEECH} Piha`, hints);
      assert.equal(speech.result.rawText, `${SPEECH} Piha`);
    });
  }
});
