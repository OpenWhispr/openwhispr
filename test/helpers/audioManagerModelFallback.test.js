const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

test("dictation transcription fallbacks dispatch settings snapshots without changing the selection", async (t) => {
  const settings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "whisper-1",
    cloudTranscriptionBaseUrl: "https://primary.example/v1",
    remoteTranscriptionUrl: "",
    transcriptionFallbackEnabled: true,
    transcriptionFallbackModels: [
      { provider: "groq", model: "whisper-large-v3-turbo" },
      { provider: "whisper", model: "base" },
    ],
    allowLocalFallback: true,
    allowOpenAIFallback: true,
  };
  const { createManager, window, setSettings, vite } = await loadAudioManager(t, {
    cachePrefix: "stt-model-fallback-",
    settingsKey: "__modelFallbackAudioSettings",
    settings,
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  window.electronAPI.listWhisperModels = async () => ({
    success: true,
    models: [{ model: "base", downloaded: true }],
  });
  const calls = [];
  const audio = new Blob(["audio"], { type: "audio/webm" });
  const manager = createManager({
    getAPIKey: async () => "saved-key",
    processWithOpenAIAPI: async (blob, metadata, wasCancelled, attempt) => {
      calls.push(attempt);
      assert.equal(blob, audio);
      throw Object.assign(new Error("quota"), { status: 429 });
    },
    processWithLocalWhisper: async (blob, model, metadata, cancelled, skipLegacy) => {
      calls.push({ model, skipLegacy });
      return { success: true, text: "hello", rawText: "hello", source: "local" };
    },
  });
  const result = await manager.processDictationBatch(audio);
  assert.equal(result.text, "hello");
  assert.equal(result.source, "local-whisper-fallback");
  assert.equal(result.transcriptionModel, "base");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].allowLocalFallback, false);
  assert.equal(calls[1].cloudTranscriptionProvider, "groq");
  assert.equal(calls[1].cloudTranscriptionModel, "whisper-large-v3-turbo");
  assert.equal(calls[1].cloudTranscriptionBaseUrl, undefined);
  assert.equal(calls[2].skipLegacy, true);
  assert.equal(settings.cloudTranscriptionProvider, "openai");

  await t.test("disabled feature preserves legacy settings", async () => {
    setSettings({ ...settings, transcriptionFallbackEnabled: false });
    calls.length = 0;
    await assert.rejects(manager.processDictationBatch(audio), { status: 429 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].allowLocalFallback, true);
  });
  await t.test("cancellation never starts a backup", async () => {
    setSettings(settings);
    let cancelled = false;
    let attempts = 0;
    manager.processWithOpenAIAPI = async () => {
      attempts++;
      cancelled = true;
      throw Object.assign(new Error("quota"), { status: 429 });
    };
    await assert.rejects(
      manager.processDictationBatch(audio, {}, () => cancelled),
      { name: "AbortError" }
    );
    assert.equal(attempts, 1);
  });
  await t.test("primary success makes no fallback request", async () => {
    let attempts = 0;
    manager.processWithOpenAIAPI = async () => {
      attempts++;
      return { success: true, text: "hello" };
    };
    await manager.processDictationBatch(audio);
    assert.equal(attempts, 1);
  });

  await t.test("policy-blocked cloud targets are skipped before dispatch", async () => {
    setSettings(settings);
    usePolicyStore.setState({
      status: "managed",
      policy: {
        transcription: { allowedModes: ["providers", "local"], allowedByokProviders: ["openai"] },
      },
    });
    const attempted = [];
    manager.processWithOpenAIAPI = async (_blob, _meta, _cancelled, snapshot) => {
      attempted.push(snapshot.cloudTranscriptionProvider);
      throw Object.assign(new Error("quota"), { status: 429 });
    };
    const result = await manager.processDictationBatch(audio);
    assert.equal(result.source, "local-whisper-fallback");
    assert.deepEqual(attempted, ["openai"]);
    usePolicyStore.setState({ status: "unmanaged", policy: null });
  });

  await t.test("streaming-only providers recover through a configured batch fallback", async () => {
    setSettings({
      ...settings,
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionModel: "nova-3",
    });
    let primaryCalls = 0;
    let provider;
    manager.processWithOpenAIAPI = async (_blob, _meta, _cancelled, snapshot) => {
      provider = snapshot.cloudTranscriptionProvider;
      return { success: true, text: "recovered" };
    };
    const result = await manager.processDictationBatch(
      audio,
      {},
      () => false,
      globalThis.__modelFallbackAudioSettings,
      async () => {
        primaryCalls++;
        throw new Error("no batch API");
      }
    );
    assert.equal(result.text, "recovered");
    assert.equal(provider, "groq");
    assert.equal(primaryCalls, 0);
  });
});

test("managed transcription bypasses personal fallbacks and an optional primary callback", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "managed-stt-fallback-",
    settingsKey: "__managedFallbackSettings",
    settings: {
      transcriptionFallbackEnabled: true,
      transcriptionFallbackModels: [{ provider: "groq", model: "whisper-large-v3" }],
    },
    mockModules: {
      "/services/managedTranscription.ts":
        'export const getManagedTranscriptionResolution = () => ({ kind: "managed", provider: "azure", deployment: "managed-stt" }); export const isManagedTranscriptionActive = () => true;',
    },
  });
  let managedCalls = 0;
  let personalCalls = 0;
  const manager = createManager({
    processWithOpenAIAPI: async () => {
      managedCalls++;
      throw Object.assign(new Error("managed quota"), { status: 429 });
    },
  });
  await assert.rejects(
    manager.processDictationBatch(
      new Blob(["audio"]),
      {},
      () => false,
      undefined,
      async () => {
        personalCalls++;
        return { text: "personal" };
      }
    ),
    { status: 429 }
  );
  assert.equal(managedCalls, 1);
  assert.equal(personalCalls, 0);
});

test("batch HTTP failover uses the correct endpoint, model and saved key and cleans up once", async (t) => {
  const settings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "whisper-1",
    openaiApiKey: "openai-test-key",
    groqApiKey: "groq-test-key",
    preferredLanguage: "en",
    customDictionary: [],
    snippets: [],
    transcriptionFallbackEnabled: true,
    transcriptionFallbackModels: [{ provider: "groq", model: "whisper-large-v3-turbo" }],
  };
  const { createManager, vite, window, setSettings } = await loadAudioManager(t, {
    cachePrefix: "stt-http-fallback-",
    settingsKey: "__fallbackHttpSettings",
    settings,
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, key: init.headers.Authorization, model: init.body.get("model") });
    return requests.length === 1
      ? new Response("quota", { status: 429 })
      : Response.json({ text: "hello world" });
  };
  let cleanupCalls = 0;
  const manager = createManager({
    cachedApiKey: null,
    cachedApiKeyProvider: null,
    processTranscription: async (text) => {
      cleanupCalls++;
      return `${text}.`;
    },
    isReasoningAvailable: async () => false,
  });
  const result = await manager.processDictationBatch(new Blob(["audio"], { type: "audio/webm" }));
  assert.equal(result.text, "hello world.");
  assert.equal(result.rawText, "hello world");
  assert.equal(cleanupCalls, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /^https:\/\/api.openai.com\//);
  assert.match(requests[1].url, /^https:\/\/api.groq.com\//);
  assert.equal(requests[0].key, "Bearer openai-test-key");
  assert.equal(requests[1].key, "Bearer groq-test-key");
  assert.equal(requests[1].model, "whisper-large-v3-turbo");
  await t.test(
    "a named key retries the same provider and model without replacing its default key",
    async () => {
      const profile = { id: "openai-backup", provider: "openai" };
      window.electronAPI.getFallbackKey = async (id, provider) =>
        id === profile.id && provider === profile.provider ? "named-openai-key" : null;
      setSettings({
        ...settings,
        transcriptionFallbackModels: [
          { provider: "openai", model: "whisper-1", keyId: profile.id },
        ],
      });
      requests.length = 0;
      const result = await manager.processDictationBatch(
        new Blob(["audio"], { type: "audio/webm" })
      );
      assert.equal(result.source, "openai-fallback");
      assert.deepEqual(
        requests.map((request) => request.key),
        ["Bearer openai-test-key", "Bearer named-openai-key"]
      );
      assert.equal(await manager.getAPIKey(settings), "openai-test-key");
      window.electronAPI.getFallbackKey = async () => null;
      requests.length = 0;
      await assert.rejects(manager.processDictationBatch(new Blob(["audio"])), { status: 429 });
      assert.equal(requests.length, 1);
    }
  );
  await t.test("proxied transcription sends a key reference to main", async () => {
    window.electronAPI.getFallbackKey = async (id, provider) =>
      id === "gemini-backup" && provider === "gemini" ? "named-gemini-key" : null;
    const { getFallbackProviders } = await vite.ssrLoadModule("/helpers/modelFallbackModels.ts");
    const model = getFallbackProviders("transcription").find((provider) => provider.id === "gemini")
      .models[0].id;
    setSettings({
      ...settings,
      transcriptionFallbackModels: [{ provider: "gemini", model, keyId: "gemini-backup" }],
    });
    let payload;
    window.electronAPI.proxyGeminiTranscription = async (data) => {
      payload = data;
      return { text: "hello world" };
    };
    requests.length = 0;
    const result = await manager.processDictationBatch(new Blob(["audio"]));
    assert.equal(result.source, "gemini-fallback");
    assert.equal(payload.fallbackKeyId, "gemini-backup");
    assert.equal(payload.model, model);
    assert.equal(JSON.stringify(payload).includes("named-gemini-key"), false);
  });
});
