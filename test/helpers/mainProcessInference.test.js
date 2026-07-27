const test = require("node:test");
const assert = require("node:assert/strict");

function createMocks() {
  let lastFetchUrl = null;
  let lastFetchBody = null;

  return {
    getLastFetch: () => ({ url: lastFetchUrl, body: lastFetchBody }),
    proxyFetch: async (url, init) => {
      lastFetchUrl = url;
      lastFetchBody = JSON.parse(init.body);

      if (url.includes("openai.com")) {
        return {
          ok: true,
          json: async () => ({
            output: [{ type: "message", content: [{ type: "output_text", text: "Generated text" }] }],
          }),
        };
      }
      if (url.includes("anthropic.com")) {
        return {
          ok: true,
          json: async () => ({
            content: [{ text: "Generated text" }],
          }),
        };
      }
      if (url.includes("googleapis.com")) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "Generated text" }] } }],
          }),
        };
      }
      return { ok: false, status: 500, text: async () => "Unknown provider" };
    },
    environmentManager: {
      getOpenAIKey: () => "sk-test-openai",
      getAnthropicKey: () => "sk-test-anthropic",
      getGeminiKey: () => "test-gemini-key",
    },
  };
}

test("calls OpenAI Responses API with correct shape", async () => {
  const { MainProcessInference } = await import("../../src/helpers/mainProcessInference.js");
  const mocks = createMocks();
  const inference = new MainProcessInference(mocks.proxyFetch, mocks.environmentManager);

  const result = await inference.processText("Hello world", {
    provider: "openai",
    model: "gpt-5.5",
    systemPrompt: "You are helpful.",
    temperature: 0.3,
  });

  assert.equal(result, "Generated text");
  const { url, body } = mocks.getLastFetch();
  assert.ok(url.includes("openai.com"));
  assert.equal(body.model, "gpt-5.5");
  assert.deepStrictEqual(body.input, [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello world" },
  ]);
});

test("calls Anthropic API with correct shape", async () => {
  const { MainProcessInference } = await import("../../src/helpers/mainProcessInference.js");
  const mocks = createMocks();
  const inference = new MainProcessInference(mocks.proxyFetch, mocks.environmentManager);

  const result = await inference.processText("Hello world", {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: "You are helpful.",
    temperature: 0.3,
  });

  assert.equal(result, "Generated text");
  const { url, body } = mocks.getLastFetch();
  assert.ok(url.includes("anthropic.com"));
  assert.equal(body.model, "claude-sonnet-4-6");
  assert.equal(body.system, "You are helpful.");
});

test("calls Gemini API with correct shape", async () => {
  const { MainProcessInference } = await import("../../src/helpers/mainProcessInference.js");
  const mocks = createMocks();
  const inference = new MainProcessInference(mocks.proxyFetch, mocks.environmentManager);

  const result = await inference.processText("Hello world", {
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    systemPrompt: "You are helpful.",
    temperature: 0.3,
  });

  assert.equal(result, "Generated text");
  const { url } = mocks.getLastFetch();
  assert.ok(url.includes("googleapis.com"));
});

test("throws when API key is missing", async () => {
  const { MainProcessInference } = await import("../../src/helpers/mainProcessInference.js");
  const mocks = createMocks();
  mocks.environmentManager.getOpenAIKey = () => null;
  const inference = new MainProcessInference(mocks.proxyFetch, mocks.environmentManager);

  await assert.rejects(
    () => inference.processText("Hello", { provider: "openai", model: "gpt-5.5", systemPrompt: "" }),
    { message: /API key not configured/i }
  );
});

test("throws on non-ok response", async () => {
  const { MainProcessInference } = await import("../../src/helpers/mainProcessInference.js");
  const mocks = createMocks();
  mocks.proxyFetch = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: "Rate limited" } }),
  });
  const inference = new MainProcessInference(mocks.proxyFetch, mocks.environmentManager);

  await assert.rejects(
    () => inference.processText("Hello", { provider: "openai", model: "gpt-5.5", systemPrompt: "" }),
    { message: /Rate limited/i }
  );
});

test("throws for unsupported provider", async () => {
  const { MainProcessInference } = await import("../../src/helpers/mainProcessInference.js");
  const mocks = createMocks();
  const inference = new MainProcessInference(mocks.proxyFetch, mocks.environmentManager);

  await assert.rejects(
    () => inference.processText("Hello", { provider: "unknown", model: "x", systemPrompt: "" }),
    { message: /Unsupported inference provider/i }
  );
});
