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
