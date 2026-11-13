const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// processWithOpenAIAPI classifies BYOK transcription failures from the throw
// shapes production sees: a renderer fetch Response or TypeError for direct
// providers, and the { error } fields main serialises for proxied ones.
async function loadManager(t, settings, window = {}) {
  const loaded = await loadAudioManager(t, {
    cachePrefix: "openwhispr-provider-errors-test-",
    settingsKey: "__providerErrorsSettings",
    settings: { useLocalWhisper: false, allowLocalFallback: false, ...settings },
  });
  Object.assign(loaded.window.electronAPI, window);
  return loaded.createManager({
    isProcessing: true,
    _activeTranscriptionAbortController: null,
    getEffectiveSttLanguage: () => "auto",
    getAPIKey: async () => "test-key",
    getWhisperPrompt: () => null,
    getKeyterms: () => [],
    isDictionaryEcho: () => false,
    processTranscription: async (text) => text,
    isReasoningAvailable: async () => false,
  });
}

const selfHostedSettings = {
  cloudTranscriptionMode: "byok",
  // Self-hosted dictation leaves the provider setting at its default.
  cloudTranscriptionProvider: "openai",
  transcriptionMode: "self-hosted",
  remoteTranscriptionUrl: "https://stt.example.com/v1",
  remoteTranscriptionModel: "whisper-large-v3",
};

const recording = () => new Blob(["recording"], { type: "audio/webm" });

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected processWithOpenAIAPI to reject");
}

test("a self-hosted 404 blames the user's server, not OpenAI", async (t) => {
  const manager = await loadManager(t, selfHostedSettings);
  t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_ERROR");
  assert.equal(error.messageKey, "providerErrors.selfHosted.unknown");
  assert.equal(error.message, "Your server returned an unexpected error.");
  assert.doesNotMatch(error.message, /OpenAI/);
});

test('a direct-fetch "Failed to fetch" asks to check the key and connection', async (t) => {
  const manager = await loadManager(t, { cloudTranscriptionProvider: "groq" });
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_NO_RESPONSE");
  assert.equal(error.messageKey, "providerErrors.noResponse");
  assert.equal(error.settingsTarget, "speechToText");
  assert.equal(error.messageParams.provider, "Groq");
  assert.equal(error.surface, "transcription");
});

test("a cancelled direct fetch stays an AbortError", async (t) => {
  const manager = await loadManager(t, { cloudTranscriptionProvider: "openai" });
  t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.name, "AbortError");
  assert.equal(error.code, 20);
  assert.equal(error.messageKey, undefined);
});

test("a proxied provider's net::ERR_* failure is classified with its display name", async (t) => {
  const manager = await loadManager(
    t,
    { cloudTranscriptionProvider: "mistral", cloudTranscriptionModel: "voxtral-mini-latest" },
    // What serializeIpcError returns for an unclassified net.fetch rejection.
    { proxyMistralTranscription: async () => ({ error: "net::ERR_INTERNET_DISCONNECTED" }) }
  );

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_UNREACHABLE");
  assert.equal(error.messageParams.provider, "Mistral");
  assert.equal(error.message, "Couldn't reach Mistral. Check your connection.");
});

test("a proxied provider's already-classified failure passes through unchanged", async (t) => {
  const manager = await loadManager(
    t,
    { cloudTranscriptionProvider: "mistral", cloudTranscriptionModel: "voxtral-mini-latest" },
    {
      proxyMistralTranscription: async () => ({
        error: "Mistral rejected your API key.",
        code: "PROVIDER_AUTH_FAILED",
        messageKey: "providerErrors.authFailed",
        messageParams: { provider: "Mistral" },
        settingsTarget: "speechToText",
        status: 401,
        surface: "transcription",
      }),
    }
  );

  const error = await rejection(manager.processWithOpenAIAPI(recording()));

  assert.equal(error.code, "PROVIDER_AUTH_FAILED");
  assert.equal(error.status, 401);
  assert.equal(error.settingsTarget, "speechToText");
});

test("self-hosted batch dictation sends custom headers and preserves auth without leaking to OpenAI", async (t) => {
  const calls = [];
  const manager = await loadManager(t, {
    ...selfHostedSettings,
    selfHostedSttHeaders: [{ name: "X-API-Key", value: "local-test-key" }],
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ text: "test" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await manager.processWithOpenAIAPI(recording());
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers["x-api-key"], "local-test-key");
  assert.equal(calls[0].headers.authorization, "Bearer test-key");
  assert.equal(new Headers(calls[0].headers).has("content-type"), false);
  const other = await loadManager(t, {
    cloudTranscriptionProvider: "openai",
    selfHostedSttHeaders: [{ name: "X-API-Key", value: "local-test-key" }],
  });
  await other.processWithOpenAIAPI(recording());
  assert.equal(new Headers(calls.at(-1).headers).has("x-api-key"), false);
});

test("self-hosted dictation with no effective custom headers keeps redirect follow", async (t) => {
  const manager = await loadManager(t, {
    ...selfHostedSettings,
    selfHostedSttHeaders: [{ name: "", value: "" }],
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.redirect, "follow");
    return new Response(JSON.stringify({ text: "test" }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  await manager.processWithOpenAIAPI(recording());
});
