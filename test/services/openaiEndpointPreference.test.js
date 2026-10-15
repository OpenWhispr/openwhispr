const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

// openai.ts caches endpoint preferences in a module-level Map, so a base shared
// between tests would make them order-dependent. One base per test.
const SHARED_BASE = "https://shared-base.example/v1";
const LLAMACPP_BASE = "https://llamacpp.example/v1";
const LEGACY_BASE = "https://legacy-pref.example/v1";

function makeCtx() {
  return {
    getApiKey: async () => "test-key",
    getSystemPrompt: () => "Clean the transcript",
    getCustomDictionary: () => [],
    getPreferredLanguage: () => "en",
    getUiLanguage: () => "en",
    callChatCompletionsApi: async () => {
      throw new Error("Unexpected chat completions delegation");
    },
    calculateMaxTokens: () => 4096,
  };
}

function callProvider(openaiProvider, base, model) {
  return openaiProvider.call({
    text: "Clean this transcript",
    model,
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: base,
      customApiKey: "test-key",
      systemPrompt: "Clean the transcript",
    },
    ctx: makeCtx(),
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const responsesOk = (text) =>
  json(200, { output: [{ type: "message", content: [{ type: "output_text", text }] }] });
const chatOk = (text) =>
  json(200, { choices: [{ message: { content: text }, finish_reason: "stop" }] });

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push(`${method} ${endpoint}${body?.model ? ` (${body.model})` : ""}`);
    return handler({ endpoint, method, model: body?.model });
  };
  return requests;
}

test("a model on /responses still recovers after another model on the same base learned chat", async (t) => {
  const requests = installFetch(t, ({ endpoint, method, model }) => {
    if (method === "GET" && endpoint.endsWith("/models")) {
      return json(401, { error: { message: "unauthorized" } });
    }
    if (model === "glm-chat-only") {
      return endpoint.endsWith("/chat/completions")
        ? chatOk("Chat answer")
        : json(404, { error: { message: "not found" } });
    }
    if (model === "luna-responses-only") {
      return endpoint.endsWith("/responses")
        ? responsesOk("Responses answer")
        : json(500, { error: { message: "upstream error" } });
    }
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  });

  const { openaiProvider } = await load();
  assert.equal(await callProvider(openaiProvider, SHARED_BASE, "glm-chat-only"), "Chat answer");
  requests.length = 0;

  const result = await callProvider(openaiProvider, SHARED_BASE, "luna-responses-only");

  assert.equal(result, "Responses answer");
  assert.deepEqual(requests, [
    `POST ${SHARED_BASE}/chat/completions (luna-responses-only)`,
    `POST ${SHARED_BASE}/responses (luna-responses-only)`,
  ]);
});

test("the chat endpoint's real error surfaces when the /responses fallback is not found", async (t) => {
  installFetch(t, ({ endpoint, method }) => {
    if (method === "GET" && endpoint.endsWith("/models")) {
      return json(200, { data: [{ id: "local-model", owned_by: "llamacpp" }] });
    }
    if (endpoint.endsWith("/chat/completions")) {
      return json(400, {
        error: { message: "the request exceeds the available context size" },
      });
    }
    if (endpoint.endsWith("/responses")) {
      return json(404, { error: { message: "File Not Found" } });
    }
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  });

  const { openaiProvider } = await load();

  await assert.rejects(callProvider(openaiProvider, LLAMACPP_BASE, "local-model"), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
});

test("a legacy base-keyed preference in localStorage is still honored", async (t) => {
  const store = new Map([["openAiEndpointPreference", JSON.stringify({ [LEGACY_BASE]: "chat" })]]);
  const originalWindow = global.window;
  t.after(() => {
    if (originalWindow === undefined) delete global.window;
    else global.window = originalWindow;
  });
  global.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
  };
  const requests = installFetch(t, ({ endpoint, method }) => {
    if (endpoint.endsWith("/chat/completions")) {
      return chatOk("Legacy chat answer");
    }
    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  });

  const { openaiProvider } = await load();
  const result = await callProvider(openaiProvider, LEGACY_BASE, "any-model");

  assert.equal(result, "Legacy chat answer");
  assert.deepEqual(requests, [`POST ${LEGACY_BASE}/chat/completions (any-model)`]);
});
