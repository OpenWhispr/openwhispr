const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("custom endpoint preferences are stored and looked up per model", async (t) => {
  installBrowserGlobals(t, {});
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-model-endpoint-test-" });
  const { openaiProvider } = await vite.ssrLoadModule("/services/ai/inferenceProviders/openai.ts");

  const requestedEndpoints = [];

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    const method = init.method || "GET";
    requestedEndpoints.push({ method, endpoint });

    if (method === "GET" && endpoint.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
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

    if (endpoint.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "Chat output" },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`Unexpected request: ${method} ${endpoint}`);
  };

  const makeCall = (model) =>
    openaiProvider.call({
      text: "hello",
      model,
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://custom-byom.example/v1",
        customApiKey: "test-key",
        systemPrompt: "Clean transcript",
      },
      ctx: {
        getApiKey: async () => "test-key",
        getSystemPrompt: () => "Clean transcript",
        getCustomDictionary: () => [],
        getPreferredLanguage: () => "en",
        getUiLanguage: () => "en",
        callChatCompletionsApi: async () => {
          throw new Error("Unexpected chat delegation");
        },
        calculateMaxTokens: () => 4096,
      },
    });

  // Call 1 with model A: default candidates are /responses then /chat/completions.
  // /responses succeeds, so model A remembers 'responses'.
  await makeCall("model-responses");
  assert.equal(
    requestedEndpoints.some((r) => r.endpoint.endsWith("/responses")),
    true
  );

  // Now pretend a model B failed /responses and fell back to 'chat'.
  // We can simulate an existing stored preference for model B in localStorage.
  const stored = JSON.parse(globalThis.localStorage.getItem("openAiEndpointPreference") || "{}");
  stored["https://custom-byom.example/v1#model-chat"] = "chat";
  globalThis.localStorage.setItem("openAiEndpointPreference", JSON.stringify(stored));

  // Call 2 with model B: should immediately use /chat/completions without trying /responses first
  requestedEndpoints.length = 0;
  await makeCall("model-chat");
  assert.equal(requestedEndpoints.length, 1);
  assert.equal(requestedEndpoints[0].endpoint.endsWith("/chat/completions"), true);

  // Call 3 with model A again: should still use /responses (not broken by model B's chat preference)
  requestedEndpoints.length = 0;
  await makeCall("model-responses");
  assert.equal(requestedEndpoints.length, 1);
  assert.equal(requestedEndpoints[0].endpoint.endsWith("/responses"), true);
});
