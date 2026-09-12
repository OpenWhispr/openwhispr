const test = require("node:test");
const assert = require("node:assert/strict");

const loadRouting = () => import("../../src/helpers/dictationStreamingRouting.js");
const loadTokens = () => import("../../src/helpers/realtimeTokenProviders.js");

const deps = (customKey = "custom-key", openaiKey = "openai-key") => ({
  environmentManager: {
    getCustomTranscriptionKey: () => customKey,
    getOpenAIKey: () => openaiKey,
  },
  postServerToken: async () => ({ clientSecret: "server-secret" }),
});

test("custom BYOK carries its base URL through the openai-realtime session options", async () => {
  const { resolveStreamingProviderName, buildStreamingSessionOptions } = await loadRouting();
  const settings = {
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionBaseUrl: "https://speech.example.com/v1",
  };
  const providerName = resolveStreamingProviderName({
    settings,
    context: "dictation",
    sttConfig: null,
  });
  assert.equal(providerName, "openai-realtime");
  assert.equal(
    buildStreamingSessionOptions({ providerName, settings, language: "en", keyterms: [] }).baseUrl,
    "https://speech.example.com/v1"
  );
});

test("non-custom OpenAI BYOK never inherits the custom base URL", async () => {
  const { buildStreamingSessionOptions } = await loadRouting();
  const options = buildStreamingSessionOptions({
    providerName: "openai-realtime",
    settings: {
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionModel: "gpt-4o-mini-transcribe",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionBaseUrl: "https://must-not-leak.example/v1",
    },
    language: "en",
    keyterms: [],
  });
  assert.equal(Object.hasOwn(options, "baseUrl"), false);
});

test("custom realtime returns the Custom key and base URL as one connection credential", async () => {
  const { fetchRealtimeTokenForProvider } = await loadTokens();
  assert.deepEqual(
    await fetchRealtimeTokenForProvider("openai-realtime", deps(), {
      mode: "byok",
      baseUrl: "https://speech.example.com/v1",
    }),
    { key: "custom-key", baseUrl: "https://speech.example.com/v1" }
  );
});

test("unauthenticated custom realtime is allowed, matching the Custom batch path", async () => {
  const { fetchRealtimeTokenForProvider } = await loadTokens();
  assert.deepEqual(
    await fetchRealtimeTokenForProvider("openai-realtime", deps(""), {
      mode: "byok",
      baseUrl: "http://localhost:8000/v1",
    }),
    { key: "", baseUrl: "http://localhost:8000/v1" }
  );
});

test("ordinary OpenAI BYOK remains a plain OpenAI key", async () => {
  const { fetchRealtimeTokenForProvider } = await loadTokens();
  assert.equal(
    await fetchRealtimeTokenForProvider("openai-realtime", deps("custom-key", "openai-key"), {
      mode: "byok",
    }),
    "openai-key"
  );
});
