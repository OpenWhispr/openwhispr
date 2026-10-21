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

// GLM-5.3 reasons at max unless asked otherwise, and on a long meeting that
// thinking spent the whole 4,096-token notes budget before any notes (#2008).
const glmNotesCall = (config = {}) => ({
  text: TRANSCRIPT,
  model: "glm-5.3",
  agentName: null,
  config: {
    provider: "custom",
    baseUrl: "https://glm-host.example/v1",
    customApiKey: "test-key",
    systemPrompt: "Summarize",
    maxTokens: 4096,
    ...config,
  },
  ctx: makeCtx(),
});

test("a GLM-5.3 notes request on a Responses endpoint pins high effort", async (t) => {
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  await openaiProvider.call(glmNotesCall());

  assert.deepEqual(bodies[0].reasoning, { effort: "high" });
});

test("with thinking disabled, GLM-5.3 on a Responses endpoint gets its low floor", async (t) => {
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  await openaiProvider.call(glmNotesCall({ disableThinking: true }));

  assert.deepEqual(bodies[0].reasoning, { effort: "low" });
});

test("Responses requests carry the other families' effort facts too", async (t) => {
  const bodies = installFetch(t, () => completeMessage("Cleaned."));
  const { openaiProvider } = await load();
  const customConfig = {
    provider: "custom",
    baseUrl: "https://custom-host.example/v1",
    customApiKey: "test-key",
  };

  // gpt-oss cleanup pins low, as on chat; qwen's off value is none.
  await openaiProvider.call({
    text: "raw transcript",
    model: "gpt-oss:20b",
    agentName: null,
    config: customConfig,
    ctx: makeCtx(),
  });
  await openaiProvider.call({
    text: "raw transcript",
    model: "qwen3:32b",
    agentName: null,
    config: { ...customConfig, disableThinking: true },
    ctx: makeCtx(),
  });

  assert.deepEqual(bodies[0].reasoning, { effort: "low" });
  assert.deepEqual(bodies[1].reasoning, { effort: "none" });
});

test("a model outside the family table gets the generic off value on a Responses endpoint", async (t) => {
  const bodies = installFetch(t, () => completeMessage("# Notes"));
  const { openaiProvider } = await load();

  await openaiProvider.call({ ...glmNotesCall({ disableThinking: true }), model: "glm-5.2" });
  await openaiProvider.call({ ...glmNotesCall({ disableThinking: false }), model: "glm-5.2" });

  // "none", as the chat body's generic dialect sends (#791); thinking on leaves the default.
  assert.deepEqual(bodies[0].reasoning, { effort: "none" });
  assert.equal(bodies[1].reasoning, undefined);
});

test("a chosen level on a Responses endpoint is checked against the endpoint's host", async (t) => {
  const bodies = installFetch(t, () => completeMessage("Cleaned."));
  const { openaiProvider } = await load();
  const xaiCall = (reasoningEffort) => ({
    text: "raw transcript",
    model: "grok-4.7",
    agentName: null,
    config: {
      provider: "custom",
      baseUrl: "https://api.x.ai/v1",
      customApiKey: "test-key",
      disableThinking: false,
      reasoningEffort,
    },
    ctx: makeCtx(),
  });

  await openaiProvider.call(xaiCall("xhigh"));
  // x.ai takes no "minimal", so it's left at the server's default.
  await openaiProvider.call(xaiCall("minimal"));

  assert.deepEqual(bodies[0].reasoning, { effort: "xhigh" });
  assert.equal(bodies[1].reasoning, undefined);
});

test("a Custom endpoint that rejects the off value pays the 400 once, not on every request", async (t) => {
  // e.g. Azure OpenAI with a non-reasoning deployment, whose name we can't recognise.
  const bodies = installFetch(t, (body) =>
    body.reasoning
      ? jsonResponse({ error: { message: "Unsupported parameter: 'reasoning.effort'" } }, 400)
      : completeMessage("Cleaned.")
  );
  const { openaiProvider } = await load();
  const cleanup = () =>
    openaiProvider.call({
      text: "raw transcript",
      model: "gpt-4o-prod",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://rejecting-host.example/v1",
        customApiKey: "test-key",
        disableThinking: true,
      },
      ctx: makeCtx(),
    });

  assert.equal(await cleanup(), "Cleaned.");
  assert.equal(await cleanup(), "Cleaned.");

  assert.deepEqual(
    bodies.map((body) => body.reasoning),
    [{ effort: "none" }, undefined, undefined]
  );
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
