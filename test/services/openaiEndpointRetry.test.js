const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

test("Responses retries when a permanent Chat fallback follows a transient failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const requestedEndpoints = [];
  let responsesAttempts = 0;

  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    const method = init.method || "GET";
    requestedEndpoints.push(`${method} ${endpoint}`);

    if (method === "GET" && endpoint.endsWith("/models")) {
      return new Response(JSON.stringify({ error: { message: "models unavailable" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (endpoint.endsWith("/responses")) {
      responsesAttempts += 1;
      if (responsesAttempts === 1) {
        return new Response(JSON.stringify({ error: { message: "request timeout" } }), {
          status: 408,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Recovered response" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (endpoint.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: "chat unsupported" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  };

  const { openaiProvider } = await load();
  const resultPromise = openaiProvider.call({
    text: "Clean this transcript",
    model: "responses-only-model",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: "https://responses-only.example/v1",
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
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await resultPromise;

  assert.equal(result, "Recovered response");
  assert.deepEqual(requestedEndpoints, [
    "GET https://responses-only.example/v1/models",
    "POST https://responses-only.example/v1/responses",
    "POST https://responses-only.example/v1/chat/completions",
    "POST https://responses-only.example/v1/responses",
  ]);
});
