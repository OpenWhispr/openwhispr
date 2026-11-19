const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

const providerContext = {
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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const chatReply = (text) => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

// `serves(url)` returns a Response for a POST the fake server handles, or
// undefined for a 404. Model discovery (GET /models) always 404s here.
function installFetch(t, serves) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requested = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    requested.push(`${method} ${url}`);
    if (method === "GET") return json({}, 404);
    return serves(url) ?? json({ error: { message: "Not Found" } }, 404);
  };
  return requested;
}

// openai.ts caches per base URL at module scope, so every test uses its own host.
function callCustom(baseUrl) {
  return load().then(({ openaiProvider }) =>
    openaiProvider.call({
      text: "raw transcript",
      model: "openai/gpt-4o-mini",
      agentName: null,
      config: { provider: "custom", baseUrl, customApiKey: "test-key" },
      ctx: providerContext,
    })
  );
}

test("a gateway base without /v1 falls back to the base as typed when /v1 404s", async (t) => {
  const requested = installFetch(t, (url) =>
    url === "https://gateway.example/model/v1/openai/chat/completions"
      ? json(chatReply("Cleaned"))
      : undefined
  );

  const result = await callCustom("https://gateway.example/model/v1/openai");

  assert.equal(result, "Cleaned");
  assert.deepEqual(
    requested.filter((r) => r.startsWith("POST")),
    [
      "POST https://gateway.example/model/v1/openai/v1/responses",
      "POST https://gateway.example/model/v1/openai/v1/chat/completions",
      "POST https://gateway.example/model/v1/openai/responses",
      "POST https://gateway.example/model/v1/openai/chat/completions",
    ]
  );
});

test("the typed base that answered is reused without retrying /v1", async (t) => {
  const base = "https://gateway-reuse.example/openai";
  const requested = installFetch(t, (url) =>
    url === `${base}/chat/completions` ? json(chatReply("Cleaned")) : undefined
  );

  await callCustom(base);
  requested.length = 0;
  const result = await callCustom(base);

  assert.equal(result, "Cleaned");
  assert.deepEqual(requested, [`POST ${base}/chat/completions`]);
});

test("a bare origin still resolves to /v1 first and never tries the typed base", async (t) => {
  const requested = installFetch(t, (url) =>
    url === "http://localhost:11434/v1/chat/completions" ? json(chatReply("Local")) : undefined
  );

  const result = await callCustom("http://localhost:11434");

  assert.equal(result, "Local");
  assert.deepEqual(requested, [
    "GET http://localhost:11434/v1/models",
    "POST http://localhost:11434/v1/responses",
    "POST http://localhost:11434/v1/chat/completions",
  ]);
});

test("a base already ending in /v1 has no typed-base fallback", async (t) => {
  const requested = installFetch(t, () => undefined);

  await assert.rejects(callCustom("https://no-fallback.example/v1"));

  assert.deepEqual(
    requested.filter((r) => r.startsWith("POST")),
    [
      "POST https://no-fallback.example/v1/responses",
      "POST https://no-fallback.example/v1/chat/completions",
    ]
  );
});

test("when both bases 404, the /v1 base's error is surfaced", async (t) => {
  installFetch(t, (url) =>
    url === "https://unknown-model.example/api/v1/chat/completions"
      ? json({ error: { message: "model 'openai/gpt-4o-mini' not found" } }, 404)
      : undefined
  );

  await assert.rejects(callCustom("https://unknown-model.example/api"), (error) => {
    assert.equal(error.code, "PROVIDER_MODEL_NOT_FOUND");
    return true;
  });
});
