const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");
const { deferred } = require("./harness/deferred");
const { ELEVENLABS_KEYTERM_REFUSALS } = require("./harness/elevenLabsAnswers");
const { transcribeWithElevenLabs } = require("../../src/helpers/elevenLabsTranscription");

// #2581 through the proxied providers: a model recites the dictionary in the
// order it was sent. Mistral's contextBias and xAI/Gemini/ElevenLabs' keyterms carry
// personal words first, Tinfoil's prompt carries them last (Whisper order), so
// each recital is recognised only against the list in its own sent order.

const SPEECH = "We agreed to ship the release on Friday after the review.";

const PROVIDERS = {
  tinfoil: "proxyTinfoilTranscription",
  mistral: "proxyMistralTranscription",
  xai: "proxyXaiTranscription",
  gemini: "proxyGeminiTranscription",
  elevenlabs: "proxyElevenlabsTranscription",
};

const KEYTERM_PROVIDERS = ["xai", "gemini", "elevenlabs"];

async function setUp(t) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-proxy-dictionary-echo-",
    settingsKey: "__proxyDictionaryEchoSettings",
  });
  const transcribe = async (
    provider,
    text,
    sharedDictionaryHints = { space: ["Qdrant"], workspace: ["Zentrum"] },
    { customDictionary = ["Piha", "Biscuit"], rejectHints = false, allowLocalFallback = false } = {}
  ) => {
    loaded.setSettings({
      useLocalWhisper: false,
      allowLocalFallback,
      cloudTranscriptionProvider: provider,
      transcriptionMode: "providers",
      customDictionary,
      snippets: [],
      sharedDictionaryHints,
    });
    let payload;
    const submittedKeyterms = [];
    loaded.window.electronAPI[PROVIDERS[provider]] = async (data) => {
      payload = data;
      if (typeof text !== "string") return text;
      if (provider !== "elevenlabs") return { text };
      return transcribeWithElevenLabs({ ...data, apiKey: "fixture" }, async (_url, init) => {
        const terms = init.body.getAll("keyterms");
        submittedKeyterms.push(terms);
        if (rejectHints && terms.length) {
          return Response.json(ELEVENLABS_KEYTERM_REFUSALS[0], { status: 400 });
        }
        return Response.json({ text });
      });
    };
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
    return { result, payload, submittedKeyterms };
  };
  return { transcribe };
}

const PERSONAL_FIRST = "Piha, Biscuit, Qdrant, Zentrum.";
const WHISPER_ORDER = "Zentrum, Qdrant, Piha, Biscuit.";

test("Scribe dictation filters echoes only against hints accepted with the transcript", async (t) => {
  const { transcribe } = await setUp(t);
  const phrase = "take one tablet by mouth daily";
  const shared = { space: [], workspace: [] };
  const dictation = await transcribe("elevenlabs", phrase, shared, {
    customDictionary: ["OpenWhispr", phrase],
  });
  assert.deepEqual(dictation.submittedKeyterms, [["OpenWhispr"]]);
  assert.equal(dictation.result.rawText, phrase);

  const stripped = await transcribe("elevenlabs", `${SPEECH} Piha, Biscuit.`, shared, {
    customDictionary: [phrase, "Piha", "Biscuit"],
  });
  assert.equal(stripped.result.rawText, SPEECH);

  const normalized = await transcribe(
    "elevenlabs",
    "Los Angeles County.",
    { space: ["Los  Angeles County", "Qdrant", "Biscuit", "Zentrum", "Dublin"], workspace: [] },
    { customDictionary: ["OpenWhispr"] }
  );
  assert.equal(normalized.result.rawText, "Los Angeles County.");

  for (const text of ["Piha, Biscuit.", `${SPEECH} Piha, Biscuit.`]) {
    const retried = await transcribe("elevenlabs", text, shared, { rejectHints: true });
    assert.deepEqual(retried.submittedKeyterms, [["Piha", "Biscuit"], []]);
    assert.equal(retried.result.rawText, text);
  }
});

test("Scribe keeps dictation that uses only one accepted keyterm", async (t) => {
  const { transcribe } = await setUp(t);
  const phrase = "review the draft today";
  const customDictionary = [phrase, "take one tablet by mouth daily"];
  for (const workspace of [[], ["Qdrant"]]) {
    for (const text of [
      "Review the draft.",
      "Review the draft today.",
      "Review, review the draft today.",
    ]) {
      const { result, submittedKeyterms } = await transcribe(
        "elevenlabs",
        text,
        { space: [], workspace },
        { customDictionary }
      );
      assert.deepEqual(submittedKeyterms, [[phrase, ...workspace]]);
      assert.equal(result.text, text);
      assert.equal(result.rawText, text);
    }
  }

  const shared = { space: ["Los Angeles County"], workspace: [] };
  const dictation = await transcribe("elevenlabs", "Los Angeles County.", shared, {
    customDictionary: ["Los Angeles", "County"],
  });
  assert.equal(dictation.result.rawText, "Los Angeles County.");

  await assert.rejects(transcribe("elevenlabs", "Piha, Biscuit.", shared), {
    code: "DICTIONARY_ECHO",
  });
});

test("Scribe receives exact-limit dictionary terms and drops longer originals", async (t) => {
  const { transcribe } = await setUp(t);
  const valid = "a".repeat(50);
  const tooLong = "b".repeat(51);
  const sharedTerm = "𠮷".repeat(50);
  const shared = { space: [sharedTerm], workspace: [] };
  const { submittedKeyterms } = await transcribe("elevenlabs", SPEECH, shared, {
    customDictionary: [valid, tooLong],
  });
  assert.deepEqual(submittedKeyterms, [[valid, sharedTerm]]);
});

test("Scribe's no-speech IPC result bypasses local fallback", async (t) => {
  const { transcribe } = await setUp(t);
  const silence = { code: "NO_SPEECH_DETECTED", error: "No speech detected in audio" };
  await assert.rejects(transcribe("elevenlabs", silence, undefined, { allowLocalFallback: true }), {
    code: silence.code,
    message: silence.error,
  });
});

test("cancelling while Scribe audio is read never starts the IPC upload", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-scribe-cancel-",
    settingsKey: "__scribeCancelSettings",
    settings: { transcriptionMode: "providers", cloudTranscriptionProvider: "elevenlabs" },
  });
  const upload = t.mock.fn(async () => ({ text: "late", acceptedKeyterms: [] }));
  window.electronAPI.proxyElevenlabsTranscription = upload;
  const manager = createManager({
    isProcessing: true,
    getAPIKey: async () => "fixture",
    getTranscriptionModel: () => "scribe_v3",
  });
  const reading = deferred();
  const bytes = deferred();
  const audio = new Blob(["sample"], { type: "audio/webm" });
  t.mock.method(audio, "arrayBuffer", () => {
    reading.resolve();
    return bytes.promise;
  });
  const pending = manager.processWithOpenAIAPI(audio);
  await reading.promise;
  assert.equal(manager.cancelProcessing(), true);
  bytes.resolve(new ArrayBuffer(6));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(upload.mock.callCount(), 0);
});

test("keyterm providers drop a recital in the personal-first order they sent", async (t) => {
  const { transcribe } = await setUp(t);

  for (const provider of KEYTERM_PROVIDERS) {
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
  await assert.rejects(transcribe("mistral", PERSONAL_FIRST), { code: "DICTIONARY_ECHO" });
  const spoken = await transcribe("mistral", WHISPER_ORDER);
  assert.equal(spoken.result.rawText, WHISPER_ORDER);
});

test("Mistral checks the 100 context-bias tokens actually sent", async (t) => {
  const { transcribe } = await setUp(t);
  const customDictionary = Array.from({ length: 150 }, (_, i) => `Term${i}`);
  const hints = { space: [], workspace: [] };
  const { payload } = await transcribe("mistral", SPEECH, hints, { customDictionary });
  assert.deepEqual(payload.contextBias, customDictionary.slice(0, 100));
  await assert.rejects(
    transcribe("mistral", payload.contextBias.join(", "), hints, { customDictionary }),
    {
      code: "DICTIONARY_ECHO",
    }
  );
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

test("keyterm providers preserve a spoken name and reject a recital of the same hints", async (t) => {
  const { transcribe } = await setUp(t);
  const hints = { space: [], workspace: [] };
  const customDictionary = ["General Hospital", "Massachusetts"];
  const name = "Massachusetts General Hospital.";

  for (const provider of KEYTERM_PROVIDERS) {
    await t.test(provider, async () => {
      await assert.rejects(
        transcribe(provider, "General Hospital, Massachusetts.", hints, { customDictionary }),
        { code: "DICTIONARY_ECHO" }
      );
      const { result, payload } = await transcribe(provider, name, hints, { customDictionary });
      assert.deepEqual(payload.keyterms, customDictionary);
      assert.equal(result.rawText, name);
      assert.equal(result.text, name);
    });
  }
});

test("keyterm providers treat a recital of every sent keyterm as an echo", async (t) => {
  const { transcribe } = await setUp(t);
  // More shared words than the Whisper window holds, all of them sent as keyterms.
  const hints = { space: [], workspace: Array.from({ length: 60 }, (_, i) => `Termword${i}`) };
  const recital = ["Piha", "Biscuit", ...hints.workspace].join(", ");

  for (const provider of KEYTERM_PROVIDERS) {
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

  for (const provider of KEYTERM_PROVIDERS) {
    await t.test(provider, async () => {
      await assert.rejects(transcribe(provider, "Piha, Biscuit.", hints), /No audio detected/);
      const speech = await transcribe(provider, `${SPEECH} Piha`, hints);
      assert.equal(speech.result.rawText, `${SPEECH} Piha`);
    });
  }
});
