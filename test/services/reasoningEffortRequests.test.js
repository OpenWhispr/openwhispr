const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The per-scope reasoning effort must reach every transport a scope can use:
// the Responses API body, Gemini's native thinkingConfig, and the AI SDK
// streaming requests behind the assistant panel and typed chat.

const CHOSEN = (reasoningEffort, extra = {}) => ({
  disableThinking: false,
  reasoningEffort,
  ...extra,
});

test("Responses effort: OpenAI sends the chosen level the model offers", async () => {
  const { responsesReasoningEffort } = await import("../../src/services/ai/chatRequestBody.ts");

  assert.equal(responsesReasoningEffort("gpt-5.5", "openai", CHOSEN("high")), "high");
  assert.equal(responsesReasoningEffort("gpt-6-astra", "openai", CHOSEN("max")), "max");
  // GPT-6 Astra rejects "none", so a stored "none" from another model is dropped.
  assert.equal(responsesReasoningEffort("gpt-6-astra", "openai", CHOSEN("none")), undefined);
});

test("Responses effort: Auto leaves OpenAI at the server default, toggle or not", async () => {
  const { responsesReasoningEffort } = await import("../../src/services/ai/chatRequestBody.ts");

  assert.equal(responsesReasoningEffort("gpt-5.5", "openai", {}), undefined);
  assert.equal(responsesReasoningEffort("gpt-5.5", "openai", { disableThinking: true }), undefined);
});

test("Responses effort: a Custom endpoint sends any listed level (#791)", async () => {
  const { responsesReasoningEffort } = await import("../../src/services/ai/chatRequestBody.ts");

  assert.equal(responsesReasoningEffort("grok-4.3", "custom", CHOSEN("none")), "none");
  assert.equal(responsesReasoningEffort("grok-4.3", "custom", CHOSEN("max")), undefined);
});

test("Responses effort: the thinking toggle reaches a Custom endpoint's Responses API (#791)", async () => {
  const { responsesReasoningEffort } = await import("../../src/services/ai/chatRequestBody.ts");

  assert.equal(responsesReasoningEffort("grok-4.3", "custom", { disableThinking: true }), "none");
  // A family without an off switch keeps its floor.
  assert.equal(
    responsesReasoningEffort("gpt-oss-120b", "custom", { disableThinking: true }),
    "low"
  );
});

test("Gemini native: a chosen level becomes thinkingLevel; the toggle still wins", async (t) => {
  const { geminiProvider } = await import("../../src/services/ai/inferenceProviders/gemini.ts");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Clean text." }] } }],
    });
  });
  const call = (model, config) =>
    geminiProvider.call({
      text: "transcript",
      model,
      agentName: null,
      config,
      ctx: { getApiKey: async () => "test-key", getSystemPrompt: () => "Clean." },
    });

  await call("gemini-3.1-pro-preview", CHOSEN("medium"));
  assert.deepEqual(requests[0].generationConfig.thinkingConfig, {
    thinkingLevel: "medium",
    includeThoughts: false,
  });

  await call("gemini-3-flash-preview", { disableThinking: true, reasoningEffort: "high" });
  assert.deepEqual(requests[1].generationConfig.thinkingConfig, {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

async function streamRequestBody(t, { provider, model, config, keys = {} }) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getOpenAIKey: async () => keys.openai ?? "test-key",
        getGroqKey: async () => "test-key",
        getGeminiKey: async () => "test-key",
        getOpenrouterKey: async () => "test-key",
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: `openwhispr-effort-${provider}-` });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  t.after(() => reasoningService.destroy());

  const bodies = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: { message: "stop here" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    model,
    provider,
    { systemPrompt: "Answer the user.", ...config },
    undefined
  );
  await assert.rejects(async () => {
    for await (const _chunk of stream);
  });
  return bodies[0];
}

test("streaming: a Custom endpoint gets reasoning_effort", async (t) => {
  const body = await streamRequestBody(t, {
    provider: "custom",
    model: "grok-4.3",
    config: CHOSEN("low", { baseUrl: "https://api.x.ai/v1", customApiKey: "test-key" }),
  });
  assert.equal(body.reasoning_effort, "low");
});

test("streaming: native OpenAI sends the effort even for ids the SDK doesn't know", async (t) => {
  const body = await streamRequestBody(t, {
    provider: "openai",
    model: "gpt-6-astra",
    config: CHOSEN("high"),
  });
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("streaming: OpenRouter gets its reasoning object", async (t) => {
  const body = await streamRequestBody(t, {
    provider: "openrouter",
    model: "openai/gpt-5.5",
    config: CHOSEN("high"),
  });
  assert.deepEqual(body.reasoning, { effort: "high" });
});

test("streaming: Groq gets the chosen level for gpt-oss", async (t) => {
  const body = await streamRequestBody(t, {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    config: CHOSEN("high"),
  });
  assert.equal(body.reasoning_effort, "high");
});

test("streaming: Gemini gets the chosen thinkingLevel", async (t) => {
  const body = await streamRequestBody(t, {
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    config: CHOSEN("low"),
  });
  assert.deepEqual(body.generationConfig.thinkingConfig, {
    thinkingLevel: "low",
    includeThoughts: false,
  });
});

test("settings: each scope keeps its own effort", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { _llmScopeKeysMigrated: "1", _dictationAgentSeeded: "1" },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-effort-settings-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const s = await vite.ssrLoadModule("/stores/settingsStore.ts");

  s.setResolvedLLMConfig("dictationCleanup", { reasoningEffort: "low" });
  s.setResolvedLLMConfig("chatIntelligence", { reasoningEffort: "high" });
  const state = s.useSettingsStore.getState();

  assert.equal(localStorage.getItem("cleanupReasoningEffort"), "low");
  assert.equal(s.selectResolvedLLMConfig(state, "dictationCleanup").reasoningEffort, "low");
  assert.equal(s.selectResolvedLLMConfig(state, "chatIntelligence").reasoningEffort, "high");
  // Note formatting inherits cleanup's model, not its effort.
  assert.equal(s.selectResolvedLLMConfig(state, "noteFormatting").reasoningEffort, undefined);
});
