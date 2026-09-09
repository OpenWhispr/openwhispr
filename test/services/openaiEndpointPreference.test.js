const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const mod = await import("../../src/services/ai/inferenceProviders/openai.ts");
  return mod.default || mod;
};

test.beforeEach(async () => {
  const { clearEndpointPreferenceCache } = await load();
  clearEndpointPreferenceCache();
  if (typeof globalThis.window === "undefined") {
    globalThis.window = {};
  }
  const store = new Map();
  globalThis.window.localStorage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
});

test("default endpoint candidates include responses first and chat second", async () => {
  const { getEndpointCandidates } = await load();
  const candidates = getEndpointCandidates("https://opencode.ai/zen/go/v1", "gpt-5.6-luna");

  assert.deepEqual(candidates, [
    { url: "https://opencode.ai/zen/go/v1/responses", type: "responses" },
    { url: "https://opencode.ai/zen/go/v1/chat/completions", type: "chat" },
  ]);
});

test("explicit URL suffixes are preserved as single candidate", async () => {
  const { getEndpointCandidates } = await load();
  const respCandidates = getEndpointCandidates("https://opencode.ai/zen/go/v1/responses");
  assert.deepEqual(respCandidates, [
    { url: "https://opencode.ai/zen/go/v1/responses", type: "responses" },
  ]);

  const chatCandidates = getEndpointCandidates("https://opencode.ai/zen/go/v1/chat/completions");
  assert.deepEqual(chatCandidates, [
    { url: "https://opencode.ai/zen/go/v1/chat/completions", type: "chat" },
  ]);
});

test("preferences are isolated per model on the same base URL", async () => {
  const { getEndpointCandidates, readStoredPreference, rememberPreference } = await load();
  const base = "https://opencode.ai/zen/go/v1";

  // Remember 'chat' for grok-4.5
  rememberPreference(base, "chat", "grok-4.5");

  assert.equal(readStoredPreference(base, "grok-4.5"), "chat");
  assert.equal(readStoredPreference(base, "gpt-5.6-luna"), undefined);

  // grok-4.5 candidates start with chat
  const grokCandidates = getEndpointCandidates(base, "grok-4.5");
  assert.deepEqual(grokCandidates, [
    { url: "https://opencode.ai/zen/go/v1/chat/completions", type: "chat" },
    { url: "https://opencode.ai/zen/go/v1/responses", type: "responses" },
  ]);

  // gpt-5.6-luna candidates still start with responses
  const lunaCandidates = getEndpointCandidates(base, "gpt-5.6-luna");
  assert.deepEqual(lunaCandidates, [
    { url: "https://opencode.ai/zen/go/v1/responses", type: "responses" },
    { url: "https://opencode.ai/zen/go/v1/chat/completions", type: "chat" },
  ]);

  // Now remember 'responses' for gpt-5.6-luna
  rememberPreference(base, "responses", "gpt-5.6-luna");
  assert.equal(readStoredPreference(base, "gpt-5.6-luna"), "responses");
  assert.equal(readStoredPreference(base, "grok-4.5"), "chat");
});

test("falls back from Chat to Responses when Chat returns 404", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requestedEndpoints = [];
  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    const method = init.method || "GET";
    requestedEndpoints.push(`${method} ${endpoint}`);

    if (method === "GET" && endpoint.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (endpoint.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: "Chat not supported for this model" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (endpoint.endsWith("/responses")) {
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Responses output" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  };

  const { openaiProvider, rememberPreference, readStoredPreference } = await load();
  const base = "https://opencode.ai/zen/go/v1";

  // Simulate a base-level preference of 'chat' from another model
  rememberPreference(base, "chat");

  const result = await openaiProvider.call({
    text: "Clean this text",
    model: "gpt-5.6-luna",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: base,
      customApiKey: "test-key",
      systemPrompt: "Clean the transcript",
    },
    ctx: {
      getApiKey: async () => "test-key",
      getSystemPrompt: () => "Clean the transcript",
      getCustomDictionary: () => [],
      getPreferredLanguage: () => "en",
      getUiLanguage: () => "en",
      callChatCompletionsApi: async () => {
        throw new Error("Unexpected chat completions delegation");
      },
      calculateMaxTokens: () => 4096,
    },
  });

  assert.equal(result, "Responses output");
  // Verified chat was attempted first, then responses succeeded
  assert.ok(requestedEndpoints.includes("POST https://opencode.ai/zen/go/v1/chat/completions"));
  assert.ok(requestedEndpoints.includes("POST https://opencode.ai/zen/go/v1/responses"));

  // Subsequent call for gpt-5.6-luna now has 'responses' remembered
  assert.equal(readStoredPreference(base, "gpt-5.6-luna"), "responses");
});

test("falls back from Responses to Chat when Responses returns 404", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requestedEndpoints = [];
  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    const method = init.method || "GET";
    requestedEndpoints.push(`${method} ${endpoint}`);

    if (method === "GET" && endpoint.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (endpoint.endsWith("/responses")) {
      return new Response(JSON.stringify({ error: { message: "Responses unsupported" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (endpoint.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Chat output" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  };

  const { openaiProvider, readStoredPreference } = await load();
  const base = "https://opencode.ai/zen/go/v1";

  const result = await openaiProvider.call({
    text: "Clean this text",
    model: "grok-4.5",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: base,
      customApiKey: "test-key",
      systemPrompt: "Clean the transcript",
    },
    ctx: {
      getApiKey: async () => "test-key",
      getSystemPrompt: () => "Clean the transcript",
      getCustomDictionary: () => [],
      getPreferredLanguage: () => "en",
      getUiLanguage: () => "en",
      callChatCompletionsApi: async () => {
        throw new Error("Unexpected chat completions delegation");
      },
      calculateMaxTokens: () => 4096,
    },
  });

  assert.equal(result, "Chat output");
  assert.equal(readStoredPreference(base, "grok-4.5"), "chat");
});
