const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager: loadSharedAudioManager } = require("./harness/audioManager");

// Every case drives a prototype-only manager through the shared renderer
// harness; only the model, endpoint and dictionary prompt differ per case.
async function loadAudioManager(t, opts) {
  const loaded = await loadSharedAudioManager(t, opts);
  return {
    ...loaded,
    createManager: (overrides = {}) =>
      loaded.createManager({
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

// Inspect the encoded field, including FormData's UTF-8 and CRLF conversion.
async function serializePrompt(endpoint, init) {
  const request = new Request(endpoint, init);
  const body = Buffer.from(await request.arrayBuffer());
  const boundary = request.headers.get("content-type").split("boundary=")[1];
  const marker = Buffer.from('Content-Disposition: form-data; name="prompt"\r\n\r\n');
  const start = body.indexOf(marker);
  if (start === -1) return { prompt: null, promptBytes: 0 };
  const valueStart = start + marker.length;
  const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), valueStart);
  assert.notEqual(end, -1, "serialized prompt must terminate at the multipart boundary");
  const field = body.subarray(valueStart, end);
  return { prompt: field.toString("utf8"), promptBytes: field.length };
}

// Captures the prompt field each transcription request actually sent.
function capturePrompts(t) {
  const originalFetch = globalThis.fetch;
  const prompts = [];
  globalThis.fetch = async (endpoint, init) => {
    prompts.push((await serializePrompt(endpoint, init)).prompt);
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

  await t.test("groq stays under its 896-byte request limit", async () => {
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
    assert.ok(Buffer.byteLength(prompts[0]) <= 896, "Groq prompt must stay within 896 bytes");
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

  await t.test(
    "a self-hosted server with a free-text model name is treated as Whisper",
    async () => {
      setSettings({
        useLocalWhisper: false,
        allowLocalFallback: false,
        cloudTranscriptionProvider: "custom",
        cloudTranscriptionBaseUrl: "https://stt.internal.example/v1",
      });
      const prompts = capturePrompts(t);
      // Self-hosted and custom endpoints take whatever model name the user typed;
      // most such servers are Whisper-family under a name that never says so.
      const manager = createManager({
        getTranscriptionModel: () => "Systran/faster-distil-large-v3",
        getTranscriptionEndpoint: () => "https://stt.internal.example/v1/audio/transcriptions",
        getWhisperPrompt: () => longPrompt,
      });

      await manager.processWithOpenAIAPI(audioBlob, {});
      assert.equal(prompts.length, 1);
      assert.ok(
        prompts[0].length <= 900,
        `an unrecognized model must not get the 4o budget, got ${prompts[0].length}`
      );
    }
  );

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

test("local whisper receives the dictionary whole, and echo checks see what it sent", async (t) => {
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
  // A client-side character cut cannot give the head priority here: whisper.cpp
  // reads ~223 prompt tokens and keeps the TAIL of anything longer, so trimming
  // to 900 chars would only pick a different middle slice — and would leave the
  // echo recovery classifying against a string the decoder never saw.
  assert.equal(seen[0], longPrompt, "local whisper must receive the dictionary uncut");
});

test("Groq caps the final serialized prompt at 896 UTF-8 bytes", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-groq-prompt-bytes-test-",
    settingsKey: "__groqPromptBytesSettings",
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
  const cases = [
    ["ASCII at the boundary", "a".repeat(896), "a".repeat(896)],
    ["ASCII over the boundary", "a".repeat(897), "a".repeat(896)],
    ["accents at the boundary", "é".repeat(448), "é".repeat(448)],
    ["449 characters encoding to 897 bytes", "é".repeat(448) + "a", "é".repeat(448)],
    [
      "below the old character cap",
      "a".repeat(881) + "é".repeat(8),
      "a".repeat(881) + "é".repeat(7),
    ],
    ["CJK", "中".repeat(300), "中".repeat(298)],
    ["emoji", "😀".repeat(225), "😀".repeat(224)],
    ["combining code points", "e\u0301".repeat(299), "e\u0301".repeat(298) + "e"],
    [
      "LF expansion",
      "a".repeat(876) + "\nb\nc\nd\ne\nf\ng\nh",
      "a".repeat(876) + "\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n",
    ],
    ["CR at the cut", "a".repeat(895) + "\r", "a".repeat(895)],
    ["LF at the cut", "a".repeat(895) + "\n", "a".repeat(895)],
    ["CRLF at the cut", "a".repeat(895) + "\r\n", "a".repeat(895)],
    [
      "mixed line endings at the boundary",
      "a".repeat(887) + "\r\nb\rc\nd",
      "a".repeat(887) + "\r\nb\r\nc\r\nd",
    ],
    [
      "comma-separated entries",
      "é".repeat(200) + ", " + "à".repeat(200) + ", " + "ï".repeat(100),
      "é".repeat(200) + ", " + "à".repeat(200),
    ],
    ["short line endings", "café\rnoir\nété\r\n", "café\r\nnoir\r\nété\r\n"],
    ["empty prompt omitted", "", null],
    ["null prompt omitted", null, null],
    ["undefined prompt omitted", undefined, null],
  ];

  for (const provider of ["groq", "custom"]) {
    for (const [name, input, expected] of cases) {
      await t.test(`${provider}: ${name}`, async (t) => {
        setSettings({
          useLocalWhisper: false,
          allowLocalFallback: false,
          cloudTranscriptionProvider: provider,
          cloudTranscriptionBaseUrl: "https://api.groq.com/openai/v1",
        });
        const originalFetch = globalThis.fetch;
        t.after(() => {
          globalThis.fetch = originalFetch;
        });
        let sent;
        globalThis.fetch = async (endpoint, init) => {
          sent = await serializePrompt(endpoint, init);
          assert.equal(init.body.get("model"), "whisper-large-v3-turbo");
          assert.equal(init.body.get("language"), "fr");
          return new Response(JSON.stringify({ text: "ordinary transcription" }), {
            headers: { "content-type": "application/json" },
          });
        };
        const manager = createManager({
          getEffectiveSttLanguage: () => "fr",
          getTranscriptionModel: () => "whisper-large-v3-turbo",
          getTranscriptionEndpoint: () => "https://api.groq.com/openai/v1/audio/transcriptions",
          getWhisperPrompt: () => input,
        });
        const result = await manager.processWithOpenAIAPI(audioBlob, {});
        assert.equal(result.success, true);
        assert.equal(result.rawText, "ordinary transcription");
        assert.ok(
          sent.promptBytes <= 896,
          `${sent.promptBytes} encoded bytes exceeds Groq's limit`
        );
        assert.equal(sent.prompt, expected);
        assert.equal(
          sent.prompt?.includes("\ufffd") ?? false,
          false,
          "must not split Unicode code points"
        );
      });
    }
  }

  for (const [provider, model, expectedLength] of [
    ["openai", "whisper-1", 900],
    ["openai", "gpt-4o-mini-transcribe", 1200],
    ["custom", "local-whisper", 900],
  ]) {
    await t.test(`${provider}/${model}: multibyte text keeps its character budget`, async (t) => {
      setSettings({
        useLocalWhisper: false,
        allowLocalFallback: false,
        cloudTranscriptionProvider: provider,
        cloudTranscriptionBaseUrl: "https://stt.internal.example/v1",
      });
      const prompts = capturePrompts(t);
      const manager = createManager({
        getTranscriptionModel: () => model,
        getTranscriptionEndpoint: () => "https://stt.internal.example/v1/audio/transcriptions",
        getWhisperPrompt: () => "é".repeat(1200),
      });
      await manager.processWithOpenAIAPI(audioBlob, {});
      assert.deepEqual(prompts, ["é".repeat(expectedLength)]);
    });
  }
});

test("AudioManager applies the byte cap only to Groq selection or the exact Groq host", async (t) => {
  const { setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-groq-endpoint-prompt-test-",
    settingsKey: "__groqEndpointPromptSettings",
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
  const cases = [
    ["custom", "https://api.groq.com/openai/v1/audio/transcriptions", 448],
    ["custom", "https://API.GROQ.COM/openai/v1/audio/transcriptions", 448],
    ["custom", "https://stt.example/api.groq.com/audio/transcriptions", 900],
    ["custom", "https://stt.example/audio/transcriptions?upstream=api.groq.com", 900],
    ["custom", "https://proxy.api.groq.com/audio/transcriptions", 900],
    ["custom", "https://api.groq.com.example/audio/transcriptions", 900],
    ["groq", "https://stt.example/audio/transcriptions", 448],
  ];
  for (const [provider, endpoint, characters] of cases) {
    await t.test(`${provider}: ${endpoint}`, async (t) => {
      setSettings({
        useLocalWhisper: false,
        allowLocalFallback: false,
        cloudTranscriptionProvider: provider,
        cloudTranscriptionBaseUrl: endpoint,
      });
      const prompts = capturePrompts(t);
      const manager = createManager({
        getTranscriptionModel: () => "whisper-large-v3-turbo",
        getTranscriptionEndpoint: () => endpoint,
        getWhisperPrompt: () => "é".repeat(900),
      });
      const result = await manager.processWithOpenAIAPI(audioBlob, {});
      assert.equal(result.success, true);
      assert.deepEqual(prompts, ["é".repeat(characters)]);
    });
  }
});

test("Groq preserves Chinese bias and rejects an echo of the actual trimmed prompt", async (t) => {
  const { AudioManager, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-groq-prompt-echo-test-",
    settingsKey: "__groqPromptEchoSettings",
  });
  setSettings({
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionProvider: "groq",
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
  const dictionary = Array.from({ length: 300 }, (_, i) => `élève${i}`).join(", ");
  const { getChineseScriptPromptBias } = await import("../../src/utils/chineseScript.js");
  const { matchesDictionaryPrompt } = await import("../../src/utils/dictionaryEchoFilter.js");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let responseText;
  let sentPrompt;
  globalThis.fetch = async (endpoint, init) => {
    const sent = await serializePrompt(endpoint, init);
    sentPrompt = sent.prompt;
    assert.ok(sent.prompt.startsWith(getChineseScriptPromptBias("simplified")));
    return new Response(JSON.stringify({ text: responseText ?? sent.prompt }), {
      headers: { "content-type": "application/json" },
    });
  };
  const processed = [];
  const manager = createManager({
    getEffectiveSttLanguage: () => "zh-CN",
    getTranscriptionModel: () => "whisper-large-v3-turbo",
    getTranscriptionEndpoint: () => "https://api.groq.com/openai/v1/audio/transcriptions",
    getCustomDictionaryPrompt: () => dictionary,
    getWhisperPrompt: AudioManager.prototype.getWhisperPrompt,
    isDictionaryEcho: AudioManager.prototype.isDictionaryEcho,
    processTranscription: async (text) => {
      processed.push(text);
      return text;
    },
  });

  await assert.rejects(manager.processWithOpenAIAPI(audioBlob, {}), { code: "DICTIONARY_ECHO" });
  assert.ok(Buffer.byteLength(sentPrompt) <= 896);
  assert.equal(
    matchesDictionaryPrompt(sentPrompt, manager.getWhisperPrompt()),
    false,
    "fixture must expose the old full-prompt echo miss"
  );
  assert.deepEqual(processed, []);

  responseText = "Please remember to ask élève1 about the project tomorrow.";
  const result = await manager.processWithOpenAIAPI(audioBlob, {});
  assert.equal(result.rawText, responseText);
  assert.deepEqual(processed, [responseText]);
});

test("a shortened Groq prompt preserves speech and still rejects a full prompt echo", async (t) => {
  const { setSettings, createManager } = await loadSharedAudioManager(t, {
    cachePrefix: "openwhispr-groq-short-prompt-speech-test-",
    settingsKey: "__groqShortPromptSpeechSettings",
  });
  const audioBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
  // Dictionary import permits long phrases. Comma trimming drops this next
  // entry entirely, leaving only four unique words in the transmitted prompt.
  const longPhrase =
    "Please arrange an appointment with the engineering team after reviewing the production service logs and preparing the quarterly report for our scheduled customer meeting. "
      .repeat(6)
      .trim();
  const dictionary = ["OpenWhispr", "on my way", longPhrase, "Electron", "renderer", "TypeScript"];
  const cases = [
    ["ordinary short speech", "On my way.", false],
    ["reordered shared vocabulary", "My way on OpenWhispr.", false],
    ["a phrase spoken twice", "On my way, on my way.", false],
    ["full sent-prompt echo", "OpenWhispr, on my way", true],
    ["echo with case, punctuation and spacing changes", "  OPENWHISPR  ON MY WAY. ", true],
  ];

  for (const provider of ["groq", "custom"]) {
    for (const [name, responseText, echo] of cases) {
      await t.test(`${provider}: ${name}`, async (t) => {
        setSettings({
          useLocalWhisper: false,
          allowLocalFallback: false,
          cloudTranscriptionMode: "byok",
          cloudTranscriptionProvider: provider,
          cloudTranscriptionModel: "whisper-large-v3-turbo",
          cloudTranscriptionBaseUrl: "https://api.groq.com/openai/v1",
          preferredLanguage: "en",
          customDictionary: dictionary,
          snippets: [{ trigger: "on my way", replacement: "I will be there soon." }],
          useCleanupModel: false,
          useDictationAgent: false,
        });
        const originalFetch = globalThis.fetch;
        t.after(() => {
          globalThis.fetch = originalFetch;
        });
        let requests = 0;
        globalThis.fetch = async (endpoint, init) => {
          requests++;
          assert.equal(endpoint, "https://api.groq.com/openai/v1/audio/transcriptions");
          assert.equal(init.body.get("model"), "whisper-large-v3-turbo");
          assert.deepEqual(await serializePrompt(endpoint, init), {
            prompt: "OpenWhispr, on my way",
            promptBytes: 21,
          });
          return Response.json({ text: responseText });
        };
        const completed = [];
        const failures = [];
        const errors = [];
        let noAudioCount = 0;
        const manager = createManager({
          getAPIKey: async () => "test-key",
          isReasoningAvailable: async () => false,
          isProcessing: true,
          lastAudioBlob: audioBlob,
          onTranscriptionComplete: (result) => completed.push(result),
          saveFailedTranscription: (message, code) => failures.push({ message, code }),
          onError: (error) => errors.push(error),
          onNoAudio: () => noAudioCount++,
        });
        assert.equal(
          manager.isDictionaryEcho(responseText),
          false,
          "the original full-dictionary check must not decide this case"
        );

        await manager.processAudio(audioBlob, { durationSeconds: 2 });

        assert.equal(requests, 1);
        assert.deepEqual(errors, []);
        assert.equal(manager.isProcessing, false);
        assert.equal(manager.getCustomDictionaryPrompt(), [...dictionary, "on my way"].join(", "));
        if (echo) {
          assert.deepEqual(completed, []);
          assert.deepEqual(failures, [{ message: "No audio detected", code: "DICTIONARY_ECHO" }]);
          assert.equal(noAudioCount, 1);
        } else {
          assert.equal(completed.length, 1, "valid speech must reach the completion callback");
          assert.equal(completed[0].success, true);
          assert.equal(completed[0].rawText, responseText);
          assert.equal(completed[0].text, responseText);
          assert.deepEqual(failures, []);
          assert.equal(noAudioCount, 0);
        }
      });
    }
  }
});
