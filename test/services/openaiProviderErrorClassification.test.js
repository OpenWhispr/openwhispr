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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "x-request-id": "req_classify_1" },
  });
}

test("a single-candidate custom /responses endpoint's 429 insufficient_quota survives as PROVIDER_QUOTA_EXHAUSTED with its requestId", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  // Ending the base in "/responses" makes getEndpointCandidates return a
  // single candidate, so detectServerType's own "already a full endpoint"
  // check skips the GET /models probe entirely — one POST is all that fires.
  globalThis.fetch = async () =>
    jsonResponse(
      {
        error: {
          message: "You exceeded your current quota, please check your plan and billing details.",
          type: "insufficient_quota",
        },
      },
      429
    );

  const { openaiProvider } = await load();
  await assert.rejects(
    openaiProvider.call({
      text: "raw transcript",
      model: "cleanup-model",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://single-candidate.example/v1/responses",
        customApiKey: "test-key",
      },
      ctx: providerContext,
    }),
    (error) => {
      // Before the fix, the already-classified error was rebuilt from its own
      // English message, which doesn't contain the quota signal text and so
      // reclassified a 429 as a generic rate limit — dropping the requestId.
      assert.equal(error.code, "PROVIDER_QUOTA_EXHAUSTED");
      assert.equal(error.messageKey, "providerErrors.selfHosted.quotaExhausted");
      assert.equal(error.technicalDetails.requestId, "req_classify_1");
      return true;
    }
  );
});

test("OpenRouter is classified by its own name, never as self-hosted", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    jsonResponse({ error: { message: "The model `nope/nope` does not exist" } }, 404);

  const { openaiProvider } = await load();
  await assert.rejects(
    openaiProvider.call({
      text: "raw transcript",
      model: "nope/nope",
      agentName: null,
      config: { provider: "openrouter" },
      ctx: providerContext,
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_MODEL_NOT_FOUND");
      assert.equal(error.technicalDetails.provider, "OpenRouter");
      assert.doesNotMatch(error.messageKey, /selfHosted/);
      assert.match(error.message, /^OpenRouter /);
      return true;
    }
  );
});

test("a custom endpoint's error is classified self-hosted", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init = {}) => {
    const method = init.method || "GET";
    if (method === "GET") return jsonResponse({}, 404); // model discovery probe
    return jsonResponse({ error: { message: "Incorrect API key provided" } }, 401);
  };

  const { openaiProvider } = await load();
  await assert.rejects(
    openaiProvider.call({
      text: "raw transcript",
      model: "cleanup-model",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://my-own-server.example/v1",
        customApiKey: "test-key",
      },
      ctx: providerContext,
    }),
    (error) => {
      assert.equal(error.code, "PROVIDER_AUTH_FAILED");
      assert.equal(error.messageKey, "providerErrors.selfHosted.authFailed");
      assert.equal(error.technicalDetails.provider, "Your server");
      assert.match(error.message, /^Your server /);
      return true;
    }
  );
});
