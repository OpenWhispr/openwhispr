const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

const DICTIONARY = "OpenWhispr, Gizmo Labs";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

// Captures the dictionary-bearing fields of each transcription request.
function captureRequests(t) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (endpoint, init) => {
    requests.push({
      prompt: init.body.get("prompt"),
      keywords: init.body.getAll("keywords[]"),
      stream: init.body.get("stream"),
    });
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
  return requests;
}

test("the custom dictionary rides gpt-transcribe's keywords[] channel, legacy models' prompt", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-transcription-keywords-test-",
    settingsKey: "__transcriptionKeywordsSettings",
  });
  setSettings({
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionProvider: "openai",
  });
  const audioBlob = new Blob([new ArrayBuffer(8)], { type: "audio/webm" });
  // getWhisperPrompt and shouldStreamTranscription are the real prototype methods.
  const manager = (model, overrides = {}) =>
    createManager({
      getEffectiveSttLanguage: () => "auto",
      getTranscriptionModel: () => model,
      getTranscriptionEndpoint: () => OPENAI_ENDPOINT,
      getAPIKey: async () => "test-key",
      getCustomDictionaryPrompt: () => DICTIONARY,
      getKeyterms: () => [],
      isDictionaryEcho: () => false,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
      ...overrides,
    });

  await t.test("gpt-transcribe sends one keywords[] entry per term and no prompt", async () => {
    const requests = captureRequests(t);
    const result = await manager("gpt-transcribe").processWithOpenAIAPI(audioBlob, {});
    assert.equal(result.success, true);
    assert.deepEqual(requests, [
      { prompt: null, keywords: ["OpenWhispr", "Gizmo Labs"], stream: "true" },
    ]);
  });

  await t.test(
    "a Chinese script bias still travels in the prompt beside the keywords",
    async () => {
      const requests = captureRequests(t);
      await manager("gpt-transcribe", {
        getEffectiveSttLanguage: () => "zh-TW",
      }).processWithOpenAIAPI(audioBlob, {});
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].keywords, ["OpenWhispr", "Gizmo Labs"]);
      assert.match(requests[0].prompt, /繁體中文/);
      assert.doesNotMatch(requests[0].prompt, /OpenWhispr/, "dictionary must not be sent twice");
    }
  );

  await t.test("gpt-4o-mini-transcribe keeps the comma-joined prompt", async () => {
    const requests = captureRequests(t);
    await manager("gpt-4o-mini-transcribe").processWithOpenAIAPI(audioBlob, {});
    assert.deepEqual(requests, [{ prompt: DICTIONARY, keywords: [], stream: "true" }]);
  });

  // #2224: OpenAI rejects a form of more than ~1,000 parts with "Could not parse
  // multipart form", so a 1,481-term dictionary failed every dictation. zh-CN adds
  // the language and script-bias prompt parts, the most this request carries.
  for (const language of ["auto", "zh-CN"]) {
    await t.test(
      `a 1,481-term dictionary sends only the first 900 keywords (${language})`,
      async (st) => {
        const terms = Array.from({ length: 1481 }, (_, i) => `Term${i}`);
        const originalFetch = globalThis.fetch;
        st.after(() => {
          globalThis.fetch = originalFetch;
        });
        let sent;
        globalThis.fetch = async (endpoint, init) => {
          const request = new Request(endpoint, init);
          const boundary = request.headers.get("content-type").split("boundary=")[1];
          const body = await request.text();
          sent = {
            parts: body.split(`--${boundary}\r\n`).length - 1,
            keywords: init.body.getAll("keywords[]"),
            language: init.body.get("language"),
            prompt: init.body.get("prompt"),
          };
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => JSON.stringify({ text: "transcribed text" }),
          };
        };

        const result = await manager("gpt-transcribe", {
          getEffectiveSttLanguage: () => language,
          getCustomDictionaryPrompt: () => terms.join(", "),
        }).processWithOpenAIAPI(audioBlob, {});

        assert.equal(result.success, true);
        assert.ok(sent.parts < 1000, `${sent.parts} multipart parts exceeds OpenAI's form limit`);
        assert.deepEqual(sent.keywords, terms.slice(0, 900));
        if (language === "zh-CN") {
          assert.ok(sent.language, "zh-CN must send the language part");
          assert.match(sent.prompt, /简体中文/, "zh-CN must send the script-bias prompt part");
        }
      }
    );
  }

  await t.test("whisper-1 keeps the prompt and never streams", async () => {
    const requests = captureRequests(t);
    await manager("whisper-1").processWithOpenAIAPI(audioBlob, {});
    assert.deepEqual(requests, [{ prompt: DICTIONARY, keywords: [], stream: null }]);
  });
});
