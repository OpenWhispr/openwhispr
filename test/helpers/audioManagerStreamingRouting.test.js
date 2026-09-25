const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

async function loadManager(t) {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-routing-test-",
    settingsKey: "__streamingRoutingSettings",
  });
  return createManager();
}

function setSettings(overrides = {}) {
  globalThis.__streamingRoutingSettings = {
    useLocalWhisper: false,
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    openaiApiKey: "sk-test",
    isSignedIn: true,
    ...overrides,
  };
}

test("managed batch config does not disable BYOK OpenAI realtime transcription", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = { dictation: { mode: "batch" } };
  setSettings();

  assert.equal(manager.shouldUseStreaming(), true);
});

test("OpenAI dictation realtime requests identify the token provider", async (t) => {
  const manager = await loadManager(t);
  setSettings();
  const calls = [];
  globalThis.window.electronAPI.dictationRealtimeWarmup = async (options) => {
    calls.push(["warmup", options]);
    return { success: true };
  };
  globalThis.window.electronAPI.dictationRealtimeStart = async (options) => {
    calls.push(["start", options]);
    return { success: true };
  };

  const provider = manager.getStreamingProvider();
  const options = {
    model: "gpt-4o-mini-transcribe",
    mode: "byok",
  };
  await provider.warmup(options);
  await provider.start(options);

  assert.deepEqual(calls, [
    ["warmup", { ...options, provider: "openai-realtime" }],
    ["start", { ...options, provider: "openai-realtime" }],
  ]);
});

test("Gemini's live model routes onto the gemini-streaming-* channels", async (t) => {
  const manager = await loadManager(t);
  setSettings({
    cloudTranscriptionProvider: "gemini",
    cloudTranscriptionModel: "gemini-3.5-transcribe-live",
    geminiApiKey: "gm-test",
  });
  const calls = [];
  globalThis.window.electronAPI.geminiStreamingWarmup = async (options) => {
    calls.push(["warmup", options]);
    return { success: true };
  };
  globalThis.window.electronAPI.geminiStreamingStart = async (options) => {
    calls.push(["start", options]);
    return { success: true };
  };

  assert.equal(manager.getStreamingProviderName(), "gemini");
  const provider = manager.getStreamingProvider();
  assert.equal(provider.awaitsFinalTranscript, true);
  // Pinned to geminiLiveStreaming.js's DISCONNECT_TIMEOUT_MS: both sides
  // measure the same 3s from audioStreamEnd.
  assert.equal(provider.finalCeilingMs, 3000);

  const options = { provider: "gemini", model: "gemini-3.5-transcribe-live", mode: "byok" };
  await provider.warmup(options);
  await provider.start(options);

  assert.deepEqual(calls, [
    ["warmup", options],
    ["start", options],
  ]);
});

test("Gemini streaming needs a streaming model, plus a key (byok) or an account (managed)", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = { dictation: { mode: "streaming" } };
  const gemini = (overrides) =>
    setSettings({
      cloudTranscriptionProvider: "gemini",
      cloudTranscriptionModel: "gemini-3.5-transcribe-live",
      ...overrides,
    });

  gemini({ geminiApiKey: "gm-test" });
  assert.equal(manager.shouldUseStreaming(), true);

  gemini({ geminiApiKey: "" });
  assert.equal(manager.shouldUseStreaming(), false);

  gemini({ cloudTranscriptionMode: "openwhispr", isSignedIn: true });
  assert.equal(manager.shouldUseStreaming(), true);

  gemini({ cloudTranscriptionMode: "openwhispr", isSignedIn: false });
  assert.equal(manager.shouldUseStreaming(), false);

  // The batch Gemini model on the same provider stays on HTTP.
  gemini({ cloudTranscriptionModel: "gemini-3.5-transcribe", geminiApiKey: "gm-test" });
  assert.equal(manager.shouldUseStreaming(), false);
});

test("deepgram/assemblyai byok stream on the key alone, never on the batch path", async (t) => {
  const manager = await loadManager(t);
  // Batch dictation would otherwise win here; these providers have no batch route.
  manager.sttConfig = { dictation: { mode: "batch" } };

  for (const [provider, keyField, model] of [
    ["deepgram", "deepgramApiKey", "nova-3"],
    ["assemblyai", "assemblyaiApiKey", "universal-streaming-english"],
  ]) {
    setSettings({
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: model,
      [keyField]: "stt-test",
    });
    assert.equal(manager.shouldUseStreaming(), true, provider);
    assert.equal(manager.getStreamingProviderName(), provider);

    setSettings({
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: model,
      [keyField]: "",
    });
    assert.equal(manager.shouldUseStreaming(), false, `${provider} without a key`);
  }
});

test("managed OpenWhispr Cloud still respects its batch configuration", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = { dictation: { mode: "batch" } };
  setSettings({
    transcriptionMode: "openwhispr",
    cloudTranscriptionMode: "openwhispr",
  });

  assert.equal(manager.shouldUseStreaming(), false);
});

test("explicit Orukeet custom endpoint uses PCM streaming without cloud login", async (t) => {
  const manager = await loadManager(t);
  setSettings({
    transcriptionMode: "self-hosted",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "orukeet-v0.1.0",
    cloudTranscriptionBaseUrl: "https://example.com/v1",
    customTranscriptionApiKey: "test-key",
    isSignedIn: false,
  });
  assert.equal(manager.shouldUseStreaming(), true);
  assert.equal(manager.getStreamingProviderName(), "orukeet");
  assert.equal(manager.getStreamingProvider().finalizeAcknowledged, true);
  setSettings({
    transcriptionMode: "self-hosted",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "whisper-1",
    remoteTranscriptionUrl: "https://example.com/v1",
  });
  assert.equal(manager.shouldUseStreaming(), false);
});

test("managed Orukeet rollout overrides stale personal provider and model without a key", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = { dictation: { mode: "streaming" }, streamingProvider: "orukeet" };
  setSettings({
    cloudTranscriptionMode: "openwhispr",
    cloudTranscriptionProvider: "gemini",
    cloudTranscriptionModel: "gemini-3.5-transcribe",
  });
  assert.equal(manager.shouldUseStreaming(), true);
  assert.equal(manager.getStreamingProviderName(), "orukeet");
  const calls = [];
  globalThis.window.electronAPI.dictationRealtimeWarmup = async (options) => {
    calls.push(options);
    return { success: true };
  };
  await manager.warmupStreamingConnection();
  assert.equal(calls[0].mode, "openwhispr");
  assert.equal(calls[0].provider, "orukeet");
  assert.equal(calls[0].model, "orukeet-v0.1.0");
  assert.equal(calls[0].baseUrl, undefined);
  setSettings({ cloudTranscriptionMode: "openwhispr", isSignedIn: false });
  assert.equal(manager.shouldUseStreaming(), false);
  setSettings({ cloudTranscriptionMode: "openwhispr" });
  manager.sttConfig.dictation.mode = "batch";
  assert.equal(manager.shouldUseStreaming(), false);
  setSettings({ cloudTranscriptionMode: "byok" });
  assert.equal(manager.getStreamingProviderName(), "openai-realtime");
});

const orukeetConfig = { dictation: { mode: "streaming" }, streamingProvider: "orukeet" };
const managedSettings = (overrides) =>
  setSettings({ cloudTranscriptionMode: "openwhispr", isSignedIn: true, ...overrides });

test("managed Orukeet only streams languages the model covers", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = orukeetConfig;

  managedSettings({ preferredLanguage: "fr" });
  assert.equal(manager.shouldUseStreaming(), true);
  assert.equal(manager.getStreamingProviderName(), "orukeet");

  managedSettings({ preferredLanguage: "ja" });
  assert.equal(manager.shouldUseStreaming(), false);

  managedSettings({ preferredLanguage: "auto" });
  assert.equal(manager.shouldUseStreaming(), true);

  managedSettings({ preferredLanguage: "fr", isSignedIn: false });
  assert.equal(manager.shouldUseStreaming(), false);
});

test("a refused managed Orukeet session starts a batch recording instead of failing", async (t) => {
  const manager = await loadManager(t);
  manager.sttConfig = orukeetConfig;
  managedSettings({ preferredLanguage: "fr" });
  const errors = [];
  manager.onError = (error) => errors.push(error);
  const classify = (result) =>
    manager.classifyStreamingStartResult(result, { useLocalWhisper: false });

  assert.deepEqual(classify({ success: false, code: "FEATURE_NOT_ENABLED", status: 403 }), {
    needsFallback: true,
  });
  // The cached config advertised a route the server no longer grants: drop it
  // so the next recording refetches instead of retrying a denied route.
  assert.equal(manager.sttConfig, null);
  assert.equal(manager.streamingFallbackReason, "feature_disabled");

  manager.sttConfig = orukeetConfig;
  assert.deepEqual(classify({ success: false, status: 503 }), { needsFallback: true });
  assert.equal(manager.sttConfig, orukeetConfig);
  assert.equal(manager.streamingFallbackReason, "session_unavailable");

  assert.throws(() => classify({ success: false, code: "POLICY_MODE_BLOCKED", status: 403 }), {
    code: "POLICY_MODE_BLOCKED",
  });
  assert.throws(() => classify({ success: false, code: "AUTH_EXPIRED", status: 401 }), {
    code: "AUTH_EXPIRED",
  });

  // A network error, timeout or WebSocket failure has no status or code: batch
  // takes the dictation instead of it being lost behind an error.
  manager.streamingFallbackReason = null;
  assert.deepEqual(classify({ success: false, code: "NETWORK_ERROR" }), { needsFallback: true });
  assert.equal(manager.streamingFallbackReason, "session_unavailable");
  manager.streamingFallbackReason = null;
  assert.deepEqual(classify({ success: false, error: "Orukeet connection closed" }), {
    needsFallback: true,
  });
  assert.equal(manager.streamingFallbackReason, "session_unavailable");
  assert.equal(errors.length, 0);
});

test("the weekly word quota on a managed Orukeet start opens the upgrade prompt", async (t) => {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-streaming-routing-test-",
    settingsKey: "__streamingRoutingSettings",
  });
  const manager = createManager();
  manager.sttConfig = orukeetConfig;
  managedSettings({ preferredLanguage: "fr" });
  const prompts = [];
  window.electronAPI.notifyLimitReached = (data) => prompts.push(data);

  assert.throws(
    () =>
      manager.classifyStreamingStartResult(
        {
          success: false,
          code: "LIMIT_REACHED",
          status: 429,
          error: "Weekly word limit reached",
          details: { wordsUsed: 2000, limit: 2000 },
        },
        { useLocalWhisper: false }
      ),
    { code: "LIMIT_REACHED", message: "Weekly word limit reached" }
  );
  assert.deepEqual(prompts, [{ wordsUsed: 2000, limit: 2000 }]);
  // A quota denial is not a fallback: batch would be refused the same way.
  assert.ok(!manager.streamingFallbackReason);
});

test("a missing streaming API still falls back to batch for every provider", async (t) => {
  const manager = await loadManager(t);
  setSettings();
  assert.deepEqual(
    manager.classifyStreamingStartResult(
      { success: false, code: "NO_API" },
      { useLocalWhisper: false }
    ),
    { needsFallback: true }
  );
  assert.equal(manager.streamingFallbackReason, undefined);
});

test("the STT config goes stale after fifteen minutes and immediately when invalidated", async (t) => {
  const manager = await loadManager(t);
  assert.equal(manager.isSttConfigStale(), true);

  manager.setSttConfig({ success: true, dictation: { mode: "batch" } });
  const fetchedAt = manager.sttConfigFetchedAt;
  assert.equal(manager.isSttConfigStale(fetchedAt), false);
  assert.equal(manager.isSttConfigStale(fetchedAt + 14 * 60 * 1000), false);
  assert.equal(manager.isSttConfigStale(fetchedAt + 15 * 60 * 1000 + 1), true);

  manager.invalidateSttConfig();
  assert.equal(manager.sttConfig, null);
  assert.equal(manager.isSttConfigStale(fetchedAt), true);
});

test("a cloud upload reports why it was batch instead of the managed Orukeet stream", async (t) => {
  const manager = await loadManager(t);
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { ...originalNavigator, onLine: true },
    configurable: true,
  });
  t.after(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    });
  });
  manager.sttConfig = orukeetConfig;
  const captured = [];
  globalThis.window.electronAPI.cloudTranscribe = async (_audio, opts) => {
    captured.push(opts.streamingFallbackReason);
    return { success: false, error: "stop here" };
  };
  const upload = () =>
    manager
      .processWithOpenWhisprCloud(new Blob([new Uint8Array(16)], { type: "audio/webm" }))
      .catch((error) => {
        if (error.message !== "stop here") throw error;
      });

  // The language gate declined the stream.
  managedSettings({ preferredLanguage: "ja" });
  await upload();
  // A refused session start, consumed by the one recording it describes.
  managedSettings({ preferredLanguage: "fr" });
  manager.streamingFallbackReason = "feature_disabled";
  await upload();
  await upload();
  // The stream came up but produced no final; the stop path names that itself.
  await manager
    .processWithOpenWhisprCloud(new Blob([new Uint8Array(16)]), {
      streamingFallbackReason: "stream_no_final",
    })
    .catch((error) => {
      if (error.message !== "stop here") throw error;
    });
  // Batch by design (server config is not Orukeet) carries nothing.
  manager.sttConfig = { dictation: { mode: "batch" }, streamingProvider: "deepgram" };
  await upload();

  assert.deepEqual(captured, [
    "language_unsupported",
    "feature_disabled",
    undefined,
    "stream_no_final",
    undefined,
  ]);
});

// The Cloud batch pipeline end to end: upload, then cleanup or translation.
async function loadCloudPipeline(
  t,
  { translationRequested, useCleanupModel, cleanupCloudMode, preferredLanguage = "en" }
) {
  const { createManager, window } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-fallback-cleanup-",
    settingsKey: "__fallbackCleanupSettings",
    settings: {
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: true,
      useCleanupModel,
      cleanupCloudMode,
      preferredLanguage,
      translationSourceLanguage: "en",
      translationTargetLanguage: "es",
      customPrompts: {},
    },
    mockModules: {
      "/stores/settingsStore": `
        export const getSettings = () => globalThis.__fallbackCleanupSettings;
        export const getEffectiveCleanupModel = () => "cleanup-model";
        export const selectResolvedLLMConfig = () => ({ model: "cleanup-model", provider: "openwhispr" });
        export const isCloudCleanupMode = () => globalThis.__fallbackCleanupSettings.cleanupCloudMode === "openwhispr";
        export const isCloudDictationAgentMode = () => false;
        export const isCloudTranslationMode = () => true;
      `,
      "/config/prompts": `
        export const resolvePrompt = () => "translation prompt";
        export const appendScreenContextSuffix = (prompt) => prompt;
      `,
      "/dictationAgentInference": `
        export const resolveDictationAgentInference = () => ({ reachable: false, config: {} });
        export const resolveDictationAgentVisionInference = () => ({ active: false, config: {} });
      `,
      "/dictationTranslationInference": `
        export const resolveDictationTranslationInference = () => ({
          reachable: true, model: "translation-model", config: { provider: "openwhispr" }
        });
      `,
    },
  });
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true },
    configurable: true,
  });
  t.after(() =>
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
    })
  );
  const manager = createManager({
    translationRequested,
    isDictionaryEcho: () => false,
    getWhisperPrompt: () => null,
    finalizeChineseScript: async (text) => text,
    processWithReasoningModel: async () => "translated transcript",
  });
  return { manager, window };
}

for (const { name, translationRequested, useCleanupModel, cleanupCloudMode } of [
  {
    name: "cloud cleanup",
    translationRequested: false,
    useCleanupModel: true,
    cleanupCloudMode: "openwhispr",
  },
  {
    name: "cloud translation cleanup",
    translationRequested: true,
    useCleanupModel: true,
    cleanupCloudMode: "openwhispr",
  },
  {
    name: "cloud translation without cleanup",
    translationRequested: true,
    useCleanupModel: false,
    cleanupCloudMode: "openwhispr",
  },
  {
    name: "cloud translation with BYOK cleanup",
    translationRequested: true,
    useCleanupModel: true,
    cleanupCloudMode: "byok",
  },
]) {
  test(`batch fallback telemetry survives ${name}`, async (t) => {
    const { manager, window } = await loadCloudPipeline(t, {
      translationRequested,
      useCleanupModel,
      cleanupCloudMode,
    });
    const uploads = [];
    const cleanupRequests = [];
    window.electronAPI.cloudTranscribe = async (_audio, opts) => {
      uploads.push(opts);
      return { success: true, text: "raw transcript", sttProvider: "groq", sttModel: "whisper" };
    };
    window.electronAPI.cloudReason = async (_text, opts) => {
      cleanupRequests.push(opts);
      return { success: true, text: "clean transcript" };
    };
    const combinedLog = useCleanupModel && cleanupCloudMode === "openwhispr";
    for (const reason of [
      "feature_disabled",
      "rate_limited",
      "session_unavailable",
      "language_unsupported",
      "stream_no_final",
      undefined,
    ]) {
      const result = await manager.processWithOpenWhisprCloud(new Blob([new Uint8Array(16)]), {
        streamingFallbackReason: reason,
      });
      assert.equal(
        result.text,
        translationRequested ? "translated transcript" : "clean transcript"
      );
      assert.equal(uploads.at(-1).sendLogs, combinedLog ? "false" : undefined);
      assert.equal(uploads.at(-1).streamingFallbackReason, reason);
      if (combinedLog) assert.equal(cleanupRequests.at(-1).streamingFallbackReason, reason);
    }
    assert.equal(uploads.length, 6);
    assert.equal(cleanupRequests.length, combinedLog ? 6 : 0);
  });
}

const JA_DETECTION = {
  sttDetectedLanguage: "ja",
  sttDetectedLanguageConfidence: 0.97,
  sttDetectedLanguageAudioSeconds: 6,
  sttDetectedLanguageStatus: "detected",
};

test("the language fallback upload declares auto, never the detected language", async (t) => {
  const { manager, window } = await loadCloudPipeline(t, {
    translationRequested: false,
    useCleanupModel: false,
    cleanupCloudMode: "openwhispr",
    preferredLanguage: "auto",
  });
  const captured = [];
  window.electronAPI.cloudTranscribe = async (_buffer, opts) => {
    captured.push(opts);
    return { success: true, text: "日本語のテキスト", sttProvider: "openai" };
  };
  const result = await manager.processWithOpenWhisprCloud(new Blob([new Uint8Array(100)]), {
    streamingFallbackReason: "language_detected_unsupported",
    detectedLanguageFields: JA_DETECTION,
  });
  assert.equal(result.text, "日本語のテキスト");
  assert.equal(Object.hasOwn(captured[0], "language"), false);
  assert.equal(captured[0].streamingFallbackReason, "language_detected_unsupported");
  assert.equal(captured[0].sttDetectedLanguage, "ja");
  assert.equal(captured[0].sttDetectedLanguageConfidence, 0.97);
  assert.equal(captured[0].sttDetectedLanguageAudioSeconds, 6);
  assert.equal(captured[0].sttDetectedLanguageStatus, "detected");
});

test("a voice assistant upload writes its own log, since no cleanup call does", async (t) => {
  const { manager, window } = await loadCloudPipeline(t, {
    translationRequested: false,
    useCleanupModel: true,
    cleanupCloudMode: "openwhispr",
    preferredLanguage: "auto",
  });
  const agentCommands = [];
  Object.assign(manager, {
    voiceAgentRequested: true,
    consumeScreenContext: async () => null,
    processAgentCommand: async (text) => {
      agentCommands.push(text);
      return text;
    },
  });
  const uploads = [];
  window.electronAPI.cloudTranscribe = async (_audio, opts) => {
    uploads.push(opts);
    return { success: true, text: "明日の会議", sttProvider: "openai" };
  };
  const reasonCalls = [];
  window.electronAPI.cloudReason = async (...args) => {
    reasonCalls.push(args);
    return { success: true, text: "" };
  };
  await manager.processWithOpenWhisprCloud(new Blob([new Uint8Array(16)]), {
    streamingFallbackReason: "language_detected_unsupported",
    detectedLanguageFields: JA_DETECTION,
  });
  assert.deepEqual(agentCommands, ["明日の会議"]);
  assert.equal(reasonCalls.length, 0);
  assert.equal(Object.hasOwn(uploads[0], "sendLogs"), false);
  assert.equal(uploads[0].sttDetectedLanguage, "ja");
});

for (const translationRequested of [false, true]) {
  test(`with cloud ${translationRequested ? "translation " : ""}cleanup the combined log request carries the detection`, async (t) => {
    const { manager, window } = await loadCloudPipeline(t, {
      translationRequested,
      useCleanupModel: true,
      cleanupCloudMode: "openwhispr",
      preferredLanguage: "auto",
    });
    const reasonOpts = [];
    window.electronAPI.cloudTranscribe = async () => ({
      success: true,
      text: "日本語",
      sttProvider: "openai",
    });
    window.electronAPI.cloudReason = async (_text, opts) => {
      reasonOpts.push(opts);
      return { success: true, text: "日本語。" };
    };
    await manager.processWithOpenWhisprCloud(new Blob([new Uint8Array(100)]), {
      streamingFallbackReason: "language_detected_unsupported",
      detectedLanguageFields: JA_DETECTION,
    });
    assert.equal(reasonOpts.length, 1);
    assert.equal(reasonOpts[0].streamingFallbackReason, "language_detected_unsupported");
    for (const [key, value] of Object.entries(JA_DETECTION)) {
      assert.equal(reasonOpts[0][key], value, key);
    }
  });
}
