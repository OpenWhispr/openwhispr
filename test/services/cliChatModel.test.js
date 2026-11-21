const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A fake window.electronAPI that behaves like main: records the start payload and cancels,
// and lets the test push llm-cli-stream-part payloads to the subscribed listener.
function fakeApi({ startResult = { success: true } } = {}) {
  const state = { starts: [], cancels: [], listener: null, unsubscribed: 0 };
  const api = {
    llmCliStreamStart: async (payload) => {
      state.starts.push(payload);
      return startResult;
    },
    llmCliStreamCancel: async (streamId) => {
      state.cancels.push(streamId);
    },
    onLlmCliStreamPart: (cb) => {
      state.listener = cb;
      return () => {
        state.unsubscribed += 1;
      };
    },
  };
  return { api, state };
}

async function loadShim(t, api) {
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cli-chat-model-" });
  return vite.ssrLoadModule("/services/ai/cliChatModel.ts");
}

const PROMPT = [
  { role: "system", content: "Be brief." },
  { role: "user", content: [{ type: "text", text: "Hello" }] },
];

async function drain(stream) {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("doStream sends only serializable fields and relays parts until done", async (t) => {
  const { api, state } = fakeApi();
  const { createCliChatModel } = await loadShim(t, api);
  const model = createCliChatModel("codex", "default");
  const controller = new AbortController();
  const { stream } = await model.doStream({
    prompt: PROMPT,
    abortSignal: controller.signal,
    tools: [{ type: "function", name: "x" }],
  });
  await tick();

  assert.equal(state.starts.length, 1);
  const payload = state.starts[0];
  assert.deepEqual(Object.keys(payload).sort(), ["modelId", "prompt", "seat", "streamId"]);
  assert.equal(payload.seat, "codex");
  assert.equal(payload.modelId, undefined, "the CLI default model is expressed by sending none");
  assert.equal(payload.prompt, "System: Be brief.\n\nUser: Hello");
  assert.doesNotThrow(() => structuredClone(payload), "payload crosses IPC");

  state.listener({ streamId: "other", part: { type: "text-delta", id: "1", delta: "no" } });
  state.listener({ streamId: payload.streamId, part: { type: "text-start", id: "1" } });
  state.listener({
    streamId: payload.streamId,
    part: { type: "text-delta", id: "1", delta: "Hi" },
  });
  state.listener({ streamId: payload.streamId, part: { type: "text-end", id: "1" } });
  state.listener({ streamId: payload.streamId, done: true });

  const parts = await drain(stream);
  assert.deepEqual(
    parts.map((p) => p.type),
    ["text-start", "text-delta", "text-end"]
  );
  assert.equal(parts[1].delta, "Hi");
  assert.equal(state.unsubscribed, 1);
});

test("a chosen model id is forwarded", async (t) => {
  const { api, state } = fakeApi();
  const { createCliChatModel } = await loadShim(t, api);
  await createCliChatModel("claude", "haiku").doStream({ prompt: PROMPT });
  await tick();
  assert.equal(state.starts[0].modelId, "haiku");
});

test("an error part errors the stream with the classified code and a message key", async (t) => {
  const { api, state } = fakeApi();
  const { createCliChatModel } = await loadShim(t, api);
  const { stream } = await createCliChatModel("codex", "default").doStream({ prompt: PROMPT });
  await tick();
  state.listener({
    streamId: state.starts[0].streamId,
    error: "Usage limit reached",
    code: "quota-or-rate-limit",
  });
  await assert.rejects(drain(stream), (error) => {
    assert.equal(error.message, "Usage limit reached");
    assert.equal(error.code, "quota-or-rate-limit");
    assert.equal(error.messageKey, "llmSubscriptions.errors.quota-or-rate-limit");
    return true;
  });
  assert.equal(state.unsubscribed, 1);
});

test("an unknown error code falls to the generic message key", async (t) => {
  const { api, state } = fakeApi();
  const { createCliChatModel } = await loadShim(t, api);
  const { stream } = await createCliChatModel("grok", "default").doStream({ prompt: PROMPT });
  await tick();
  state.listener({ streamId: state.starts[0].streamId, error: "boom", code: "vendor-weird" });
  await assert.rejects(drain(stream), (error) => {
    assert.equal(error.messageKey, "llmSubscriptions.errors.generic");
    return true;
  });
});

test("a failed start (gate or invalid) errors the stream", async (t) => {
  const { api } = fakeApi({
    startResult: { success: false, code: "claude-disabled", error: "Claude seat is off" },
  });
  const { createCliChatModel } = await loadShim(t, api);
  const { stream } = await createCliChatModel("claude", "haiku").doStream({ prompt: PROMPT });
  await assert.rejects(drain(stream), (error) => {
    assert.equal(error.code, "claude-disabled");
    assert.equal(error.messageKey, "llmSubscriptions.errors.claude-disabled");
    return true;
  });
});

test("abort and stream cancel both call llm-cli-stream-cancel", async (t) => {
  const { api, state } = fakeApi();
  const { createCliChatModel } = await loadShim(t, api);
  const model = createCliChatModel("agy", "default");

  const controller = new AbortController();
  await model.doStream({ prompt: PROMPT, abortSignal: controller.signal });
  await tick();
  controller.abort();
  assert.deepEqual(state.cancels, [state.starts[0].streamId]);

  const second = await model.doStream({ prompt: PROMPT });
  await tick();
  await second.stream.cancel();
  assert.equal(state.cancels.length, 2);
  assert.equal(state.cancels[1], state.starts[1].streamId);
  assert.equal(state.unsubscribed >= 1, true);
});

test("doGenerate is streaming-only", async (t) => {
  const { api } = fakeApi();
  const { createCliChatModel } = await loadShim(t, api);
  await assert.rejects(createCliChatModel("codex", "default").doGenerate(), /streaming-only/);
});

async function loadProvider(t, api) {
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-cli-subscription-" });
  return vite.ssrLoadModule("/services/ai/inferenceProviders/cliSubscription.ts");
}

function callParams(overrides = {}) {
  return {
    text: "Hello",
    model: "default",
    agentName: null,
    config: { provider: "cli-codex", systemPrompt: "Be brief." },
    ctx: { getSystemPrompt: () => "unused" },
    ...overrides,
  };
}

test("cliSubscription.call collects the streamed text through the same IPC", async (t) => {
  const { api, state } = fakeApi();
  const { cliSubscriptionProvider } = await loadProvider(t, api);
  const pending = cliSubscriptionProvider.call(callParams());
  await tick();
  const { streamId, seat } = state.starts[0];
  assert.equal(seat, "codex");
  state.listener({ streamId, part: { type: "text-delta", id: "1", delta: "Hel" } });
  state.listener({ streamId, part: { type: "text-delta", id: "1", delta: "lo there" } });
  state.listener({ streamId, done: true });
  assert.equal(await pending, "Hello there");
});

test("cliSubscription.call maps an error code to the provider error shape", async (t) => {
  const { api, state } = fakeApi();
  const { cliSubscriptionProvider } = await loadProvider(t, api);
  const pending = cliSubscriptionProvider.call(callParams());
  await tick();
  state.listener({
    streamId: state.starts[0].streamId,
    error: "Not signed in",
    code: "not-signed-in",
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "not-signed-in");
    assert.equal(error.messageKey, "llmSubscriptions.errors.not-signed-in");
    return true;
  });
});

test("cliSubscription.call rejects an empty answer and a non-CLI provider", async (t) => {
  const { api, state } = fakeApi();
  const { cliSubscriptionProvider } = await loadProvider(t, api);
  const pending = cliSubscriptionProvider.call(callParams());
  await tick();
  state.listener({ streamId: state.starts[0].streamId, done: true });
  await assert.rejects(pending, (error) => error.code === "parse-failed");
  await assert.rejects(
    cliSubscriptionProvider.call(callParams({ config: { provider: "openai" } })),
    /Unsupported CLI provider/
  );
});
