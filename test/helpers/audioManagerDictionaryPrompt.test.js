const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// The dictionary prompt is built by the real getCustomDictionaryPrompt /
// getWhisperPrompt from settings: personal words and snippet triggers, then the
// active workspace's space and workspace words (sharedDictionaryHints).

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

function dictionarySettings({ personal = [], space = [], workspace = [], ...rest } = {}) {
  return {
    useLocalWhisper: false,
    allowLocalFallback: false,
    cloudTranscriptionProvider: "openai",
    customDictionary: personal,
    snippets: [],
    sharedDictionaryHints: { space, workspace },
    ...rest,
  };
}

function captureRequests(t) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_endpoint, init) => {
    requests.push({
      prompt: init.body.get("prompt"),
      keywords: init.body.getAll("keywords[]"),
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

// The zh-CN script bias getWhisperPrompt puts in front of the dictionary.
const ZH_CN_BIAS = "以下是简体中文。语言、学习、软件、网络。";

const teamWords = (prefix, count) =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);

async function setUp(t, cachePrefix) {
  const loaded = await loadAudioManager(t, {
    cachePrefix,
    settingsKey: `__${cachePrefix.replace(/[^a-z]/gi, "")}Settings`,
  });
  const openAIManager = ({ model = "whisper-1", endpoint = OPENAI_ENDPOINT, language = "auto" }) =>
    loaded.createManager({
      getEffectiveSttLanguage: () => language,
      getTranscriptionModel: () => model,
      getTranscriptionEndpoint: () => endpoint,
      getAPIKey: async () => "test-key",
      getKeyterms: () => [],
      shouldStreamTranscription: () => false,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
    });
  return { ...loaded, openAIManager };
}

const audioBlob = () => new Blob([new ArrayBuffer(8)], { type: "audio/webm" });

test("whisper prompt includes shared words after personal", async (t) => {
  const { setSettings, createManager } = await setUp(t, "openwhispr-dictionary-prompt-tiers-");
  setSettings(dictionarySettings({ personal: ["Piha"], workspace: ["ARR"] }));

  assert.equal(createManager().getCustomDictionaryPrompt(), "ARR, Piha");
});

test("a word in Personal and a shared list is sent once, in the personal spelling", async (t) => {
  const { setSettings, createManager } = await setUp(t, "openwhispr-dictionary-prompt-dedupe-");
  setSettings(
    dictionarySettings({
      personal: ["OpenWhispr"],
      space: ["Openwhispr", "Qdrant"],
      workspace: ["OPENWHISPR", "ARR"],
    })
  );

  assert.equal(createManager().getCustomDictionaryPrompt(), "ARR, Qdrant, OpenWhispr");
});

test("the OpenAI transcription request carries the formatted prompt", async (t) => {
  const { setSettings, openAIManager } = await setUp(t, "openwhispr-dictionary-prompt-openai-");

  await t.test("whisper-1 ends the prompt with the personal words", async (st) => {
    setSettings(
      dictionarySettings({ personal: ["Piha", "Biscuit"], space: ["S1"], workspace: ["W1"] })
    );
    const requests = captureRequests(st);

    const result = await openAIManager({}).processWithOpenAIAPI(audioBlob(), {});

    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].prompt, "W1, S1, Piha, Biscuit");
    assert.ok(requests[0].prompt.endsWith("Piha, Biscuit"));
  });

  await t.test("a long team list on Groq drops shared words, never personal ones", async (st) => {
    setSettings(
      dictionarySettings({
        cloudTranscriptionProvider: "groq",
        personal: ["Piha", "Biscuit"],
        snippets: [{ trigger: "my sig", replacement: "Chad" }],
        workspace: teamWords("Team", 300),
      })
    );
    const requests = captureRequests(st);

    await openAIManager({
      model: "whisper-large-v3-turbo",
      endpoint: GROQ_ENDPOINT,
    }).processWithOpenAIAPI(audioBlob(), {});

    const prompt = requests[0].prompt;
    assert.ok(
      prompt.length <= 550,
      `shared words stop at the decoder window, got ${prompt.length}`
    );
    assert.ok(prompt.length > 530, "the decoder window is filled");
    assert.ok(prompt.endsWith("Piha, Biscuit, my sig"), "personal words and triggers are the tail");
    assert.ok(prompt.startsWith("Team0000"), "shared words are cut from the end of their tier");
  });

  await t.test("a Chinese script bias counts against the provider limit", async (st) => {
    setSettings(
      dictionarySettings({
        cloudTranscriptionProvider: "groq",
        personal: ["Piha"],
        workspace: teamWords("Team", 300),
      })
    );
    const requests = captureRequests(st);

    await openAIManager({
      model: "whisper-large-v3-turbo",
      endpoint: GROQ_ENDPOINT,
      language: "zh-CN",
    }).processWithOpenAIAPI(audioBlob(), {});

    const prompt = requests[0].prompt;
    assert.ok(prompt.startsWith(`${ZH_CN_BIAS} Team0000, `), "the bias leads, then shared words");
    assert.ok(prompt.length <= 890, `bias plus dictionary must fit, got ${prompt.length}`);
    assert.ok(prompt.endsWith(", Piha"));
  });

  await t.test("gpt-transcribe sends personal words first and at most 100 shared", async (st) => {
    setSettings(
      dictionarySettings({ personal: ["Piha"], space: ["S1"], workspace: teamWords("Team", 950) })
    );
    const requests = captureRequests(st);

    await openAIManager({ model: "gpt-transcribe" }).processWithOpenAIAPI(audioBlob(), {});

    const { keywords, prompt } = requests[0];
    assert.equal(keywords.length, 1 + 100);
    assert.deepEqual(keywords.slice(0, 3), ["Piha", "S1", "Team0000"]);
    assert.equal(prompt, null, "no shared word rides in the overflow prompt");
  });

  await t.test("gpt-transcribe overflow still carries a long personal list", async (st) => {
    const personal = teamWords("Mine", 950);
    setSettings(dictionarySettings({ personal, workspace: ["Team"] }));
    const requests = captureRequests(st);

    await openAIManager({ model: "gpt-transcribe" }).processWithOpenAIAPI(audioBlob(), {});

    const { keywords, prompt } = requests[0];
    assert.deepEqual(keywords, personal.slice(0, 900));
    assert.equal(prompt, [...personal.slice(900), "Team"].join(", "));
  });

  await t.test("gpt-4o-transcribe carries at most 100 shared words", async (st) => {
    setSettings(dictionarySettings({ personal: ["Piha"], workspace: teamWords("Team", 500) }));
    const requests = captureRequests(st);

    await openAIManager({ model: "gpt-4o-transcribe" }).processWithOpenAIAPI(audioBlob(), {});

    assert.equal(
      requests[0].prompt,
      [...teamWords("Team", 100), "Piha"].join(", "),
      "the 4o budget is large, but the shared list is capped like every other STT path"
    );
  });

  await t.test("a personal-only list is sent as it always was", async (st) => {
    setSettings(dictionarySettings({ personal: ["Piha", "Biscuit"] }));
    const requests = captureRequests(st);

    await openAIManager({ model: "gpt-4o-transcribe" }).processWithOpenAIAPI(audioBlob(), {});
    await openAIManager({}).processWithOpenAIAPI(audioBlob(), {});
    await openAIManager({ model: "gpt-transcribe" }).processWithOpenAIAPI(audioBlob(), {});

    assert.equal(requests[0].prompt, "Piha, Biscuit");
    assert.equal(requests[1].prompt, "Piha, Biscuit");
    assert.deepEqual(requests[2].keywords, ["Piha", "Biscuit"]);
    assert.equal(requests[2].prompt, null);
  });

  await t.test("a personal word longer than the budget is sent cut to it", async (st) => {
    const long = "x".repeat(1000);
    setSettings(
      dictionarySettings({
        cloudTranscriptionProvider: "groq",
        personal: [long, "Piha"],
        workspace: ["Team"],
      })
    );
    const requests = captureRequests(st);
    const manager = openAIManager({ model: "whisper-large-v3-turbo", endpoint: GROQ_ENDPOINT });
    let echoPrompts = null;
    manager.isDictionaryEcho = (_text, prompt, personalPrompt) => {
      echoPrompts = [prompt, personalPrompt];
      return false;
    };

    await manager.processWithOpenAIAPI(audioBlob(), {});

    const head = "x".repeat(890);
    assert.equal(requests[0].prompt, head, "the head of the word, nothing after it");
    assert.deepEqual(echoPrompts, [head, head], "echo checks read the prompt that was sent");
  });
});

test("paths with no provider limit still send a long personal list whole", async (t) => {
  const { window, setSettings, createManager } = await setUp(
    t,
    "openwhispr-dictionary-prompt-uncapped-"
  );
  const personal = teamWords("SpecializedTerm", 100);
  const personalPrompt = personal.join(", ");
  assert.ok(personalPrompt.length > 1600, "fixture must exceed the Whisper budget");

  await t.test("personal-only is today's string", () => {
    setSettings(dictionarySettings({ personal }));
    assert.equal(createManager().getCustomDictionaryPrompt(), personalPrompt);
  });

  await t.test("shared words only fill what the personal list leaves", () => {
    setSettings(dictionarySettings({ personal, workspace: ["ARR"] }));
    assert.equal(createManager().getCustomDictionaryPrompt(), personalPrompt);

    // The Cloud API's Groq route keeps the head of an over-long prompt, so a
    // prompt that opens with shared words stays inside Groq's limit.
    setSettings(dictionarySettings({ personal: ["Piha"], workspace: teamWords("Team", 300) }));
    const prompt = createManager().getCustomDictionaryPrompt();
    assert.ok(
      prompt.length <= 550,
      `shared words stop at the decoder window, got ${prompt.length}`
    );
    assert.ok(prompt.length > 530, "the window is used, not a smaller one");
    assert.ok(prompt.endsWith(", Piha"));

    // The Cloud API's Gemini route keeps the first 100 terms, which the shared
    // words open, so they stop before the total reaches it.
    const short = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    setSettings(dictionarySettings({ personal: short("p", 30), workspace: short("w", 300) }));
    const terms = createManager().getCustomDictionaryPrompt().split(", ");
    assert.equal(terms.length, 100);
    assert.deepEqual(terms.slice(70), short("p", 30));
  });

  await t.test("with a Chinese script bias the whole prompt stays inside Groq's limit", () => {
    setSettings(dictionarySettings({ personal: ["Piha"], workspace: teamWords("Team", 300) }));
    const manager = createManager({ getEffectiveSttLanguage: () => "zh-CN" });

    const prompt = manager.getWhisperPrompt();

    assert.ok(prompt.startsWith(`${ZH_CN_BIAS} Team0000, `));
    assert.ok(prompt.length <= 550, `bias plus dictionary must fit, got ${prompt.length}`);
    assert.ok(prompt.endsWith(", Piha"));
  });

  await t.test("local whisper is sent the same string the echo check reads", async () => {
    setSettings(
      dictionarySettings({
        useLocalWhisper: true,
        localTranscriptionProvider: "whisper",
        personal: ["Piha"],
        workspace: teamWords("Team", 300),
      })
    );
    const seen = [];
    window.electronAPI.transcribeLocalWhisper = async (_buf, options) => {
      seen.push(options.initialPrompt);
      return { success: true, text: "transcribed text" };
    };
    const manager = createManager({ getEffectiveSttLanguage: () => "auto" });

    const result = await manager.processWithLocalWhisper(audioBlob(), "base", {});

    assert.equal(result.success, true);
    assert.equal(seen[0], manager.getCustomDictionaryPrompt());
    assert.ok(seen[0].endsWith(", Piha"));
  });
});

test("dictation keyterms keep every personal word and fill shared ones to 100", async (t) => {
  const { setSettings, createManager } = await setUp(t, "openwhispr-dictionary-keyterms-");
  setSettings(dictionarySettings({ personal: ["Piha"], workspace: teamWords("Team", 500) }));

  const keyterms = createManager().getKeyterms();

  assert.equal(keyterms[0], "Piha");
  assert.equal(keyterms.length, 100);
  // The echo strip still knows every shared word the prompt may have carried.
  assert.equal(createManager().getCustomDictionaryArray().length, 1 + 500);
});

test("Mistral's contextBias keeps personal words when a team list is long", async (t) => {
  const { window, setSettings, createManager } = await setUp(t, "openwhispr-dictionary-mistral-");
  const payloads = [];
  window.electronAPI.proxyMistralTranscription = async (payload) => {
    payloads.push(payload);
    return { text: "transcribed text" };
  };
  const manager = () =>
    createManager({
      getEffectiveSttLanguage: () => "auto",
      getTranscriptionModel: () => "voxtral-mini-latest",
      getAPIKey: async () => "test-key",
      getKeyterms: () => [],
      shouldStreamTranscription: () => false,
      processTranscription: async (text) => text,
      isReasoningAvailable: async () => false,
    });

  setSettings(
    dictionarySettings({
      cloudTranscriptionProvider: "mistral",
      personal: ["Piha", "Biscuit"],
      workspace: teamWords("Team", 300),
    })
  );
  await manager().processWithOpenAIAPI(audioBlob(), {});
  assert.deepEqual(payloads[0].contextBias.slice(0, 3), ["Piha", "Biscuit", "Team0000"]);
  assert.ok(payloads[0].contextBias.length <= 100);

  setSettings(
    dictionarySettings({ cloudTranscriptionProvider: "mistral", personal: ["Piha", "Gizmo Labs"] })
  );
  await manager().processWithOpenAIAPI(audioBlob(), {});
  assert.deepEqual(payloads[1].contextBias, ["Piha", "Gizmo", "Labs"], "personal-only unchanged");
});

test("echoes are caught with shared words in the prompt", async (t) => {
  const { setSettings, createManager } = await setUp(t, "openwhispr-dictionary-echo-shared-");
  setSettings(
    dictionarySettings({ personal: ["Piha", "Biscuit"], workspace: teamWords("Team", 300) })
  );
  const manager = createManager({ getEffectiveSttLanguage: () => "auto" });
  const prompt = manager.getCustomDictionaryPrompt();

  assert.equal(manager.isDictionaryEcho("Piha, Biscuit."), true, "an echo of the personal words");
  assert.equal(manager.isDictionaryEcho(prompt), true, "an echo of the decoder window");
  assert.equal(manager.isDictionaryEcho("Piha said the biscuit was great."), false);

  // Personal-only behaves as before: the personal list is the whole prompt.
  setSettings(dictionarySettings({ personal: ["Piha", "Biscuit"] }));
  assert.equal(manager.isDictionaryEcho("Piha, Biscuit."), true);
  assert.equal(manager.getPersonalDictionaryPrompt(), manager.getCustomDictionaryPrompt());
});

test("local whisper discards an echo of the personal words with shared words present", async (t) => {
  const { window, setSettings, createManager } = await setUp(
    t,
    "openwhispr-dictionary-local-echo-shared-"
  );
  setSettings(
    dictionarySettings({
      useLocalWhisper: true,
      localTranscriptionProvider: "whisper",
      personal: ["Piha", "Biscuit"],
      workspace: teamWords("Team", 300),
    })
  );
  const calls = [];
  window.electronAPI.transcribeLocalWhisper = async (_buf, options) => {
    calls.push(options);
    return { success: true, text: calls.length === 1 ? "Piha, Biscuit." : "real speech here" };
  };
  const manager = createManager({ getEffectiveSttLanguage: () => "auto" });

  const result = await manager.processWithLocalWhisper(audioBlob(), "base", {});

  assert.equal(calls.length, 2, "the echo triggers the prompt-free retry");
  assert.equal(calls[1].initialPrompt, undefined);
  assert.equal(result.rawText, "real speech here");
});
