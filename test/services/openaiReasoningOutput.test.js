const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

// A reasoning model's hidden reasoning is billed against max_output_tokens, so
// a summary-sized cap could be spent entirely on reasoning. The Responses API
// then answers "incomplete" with only a reasoning item, and the provider used
// to hand the caller its own input back as if it were the model's output —
// Generate AI Summary saved the raw transcript as the enhanced note.

const TRANSCRIPT = "## Meeting Transcript\nYou: we agreed to ship on Friday.\n".repeat(50);

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

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Serve /models as unavailable and /responses via `respond(parsedBody)`. */
function installFetch(t, respond) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const bodies = [];
  globalThis.fetch = async (input, init = {}) => {
    const endpoint = String(input);
    if ((init.method || "GET") === "GET" && endpoint.endsWith("/models")) {
      return jsonResponse({ error: { message: "unauthorized" } }, 401);
    }
    if (endpoint.endsWith("/responses")) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return respond(body);
    }
    if (endpoint.endsWith("/chat/completions")) {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return respond(body);
    }
    throw new Error(`Unexpected request: ${endpoint}`);
  };
  return bodies;
}

const completeMessage = (text) =>
  jsonResponse({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });

test("an OpenAI reasoning model gets an output cap that leaves room for its reasoning", async (t) => {
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  const result = await openaiProvider.call({
    text: TRANSCRIPT,
    model: "gpt-5.6-terra",
    agentName: null,
    config: { provider: "openai", systemPrompt: "Summarize", maxTokens: 4096 },
    ctx: makeCtx(),
  });

  assert.equal(result, "# Notes");
  assert.equal(bodies.length, 1);
  assert.ok(
    bodies[0].max_output_tokens >= 25_000,
    `expected reasoning headroom, got ${bodies[0].max_output_tokens}`
  );
});

test("a non-reasoning OpenAI model keeps the caller's output budget", async (t) => {
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  await openaiProvider.call({
    text: TRANSCRIPT,
    model: "gpt-4.1",
    agentName: null,
    config: { provider: "openai", systemPrompt: "Summarize", maxTokens: 4096 },
    ctx: makeCtx(),
  });

  assert.equal(bodies[0].max_output_tokens, 4096);
});

test("a model id the registry does not know keeps the caller's output budget", async (t) => {
  // A fine-tune or proxy id may sit on a model that rejects a cap above its own limit.
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  await openaiProvider.call({
    text: TRANSCRIPT,
    model: "ft:gpt-4o-2024-08-06:acme::abc123",
    agentName: null,
    config: { provider: "openai", systemPrompt: "Summarize", maxTokens: 4096 },
    ctx: makeCtx(),
  });

  assert.equal(bodies[0].max_output_tokens, 4096);
});

test("a custom endpoint keeps the caller's output budget even for a reasoning-shaped model id", async (t) => {
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  await openaiProvider.call({
    text: TRANSCRIPT,
    model: "gpt-5.6-terra",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: "https://reasoning-proxy.example/v1/responses",
      customApiKey: "test-key",
      systemPrompt: "Summarize",
      maxTokens: 4096,
    },
    ctx: makeCtx(),
  });

  assert.equal(bodies[0].max_output_tokens, 4096);
});

test("a Responses result that ran out of tokens before any text is an error, not the input echoed back", async (t) => {
  installFetch(t, () =>
    jsonResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", summary: [] }],
    })
  );
  const { openaiProvider } = await load();

  await assert.rejects(
    openaiProvider.call({
      text: TRANSCRIPT,
      model: "gpt-5.6-terra",
      agentName: null,
      config: { provider: "openai", systemPrompt: "Summarize", maxTokens: 4096 },
      ctx: makeCtx(),
    }),
    /ran out of output tokens/
  );
});

test("a Chat Completions result cut off before any text is an error, not the input echoed back", async (t) => {
  installFetch(t, () =>
    jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] })
  );
  const { openaiProvider } = await load();

  await assert.rejects(
    openaiProvider.call({
      text: TRANSCRIPT,
      model: "gpt-5.6-terra",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://chat-only.example/v1/chat/completions",
        customApiKey: "test-key",
        systemPrompt: "Summarize",
        maxTokens: 4096,
      },
      ctx: makeCtx(),
    }),
    /ran out of output tokens/
  );
});

test("an empty but complete response on a task with its own prompt is an error, not the input echoed back", async (t) => {
  installFetch(t, () => completeMessage(""));
  const { openaiProvider } = await load();

  await assert.rejects(
    openaiProvider.call({
      text: TRANSCRIPT,
      model: "gpt-5.6-terra",
      agentName: null,
      config: { provider: "openai", systemPrompt: "Summarize", maxTokens: 4096 },
      ctx: makeCtx(),
    }),
    /empty response/
  );
});

test("a refusal surfaces as an error carrying the model's reason", async (t) => {
  installFetch(t, () =>
    jsonResponse({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] },
      ],
    })
  );
  const { openaiProvider } = await load();

  await assert.rejects(
    openaiProvider.call({
      text: TRANSCRIPT,
      model: "gpt-5.6-terra",
      agentName: null,
      config: { provider: "openai", systemPrompt: "Summarize", maxTokens: 4096 },
      ctx: makeCtx(),
    }),
    /declined the request: I can't help with that\./
  );
});

test("an empty but complete response still falls back to the input for cleanup", async (t) => {
  installFetch(t, () => completeMessage(""));
  const { openaiProvider } = await load();

  const result = await openaiProvider.call({
    text: "raw dictation",
    model: "gpt-4.1",
    agentName: null,
    config: { provider: "openai" },
    ctx: makeCtx(),
  });

  assert.equal(result, "raw dictation");
});
