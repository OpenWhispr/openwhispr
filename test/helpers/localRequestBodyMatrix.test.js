const test = require("node:test");
const assert = require("node:assert/strict");

// Path A — the primary local LLM path — starts in the renderer at
// inferenceProviders/local.ts, crosses the process-local-reasoning IPC, and
// ends on llama-server's wire. This file pins what local.ts sends over the IPC
// and, in the matrix below, the FULL body every family × call shape puts on
// the wire through the real bridge → modelManagerBridge → llamaServer chain.

const loadProvider = () => import("../../src/services/ai/inferenceProviders/local.ts");
const loadPrompts = () => import("../../src/config/prompts/index.ts");

const CLEANUP_PROMPT = "cleanup system prompt";
const ctx = { getSystemPrompt: () => CLEANUP_PROMPT };

// Stands in for preload's processLocalReasoning: records every IPC call and
// answers with `respond`, so the renderer half runs for real up to the IPC.
function stubIpc(t, respond = async () => ({ success: true, text: "ok" })) {
  const calls = [];
  const previous = globalThis.window;
  globalThis.window = {
    electronAPI: {
      processLocalReasoning: async (...args) => {
        calls.push(args);
        return respond(...args);
      },
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  return calls;
}

// --- local.ts: shapes against the caller's config, before the systemPrompt merge ---

test("local.ts: a cleanup call shapes temperature 0 even though the IPC config carries a systemPrompt", async (t) => {
  const { localProvider } = await loadProvider();
  const { wrapCleanupTranscript } = await loadPrompts();
  const calls = stubIpc(t);

  await localProvider.call({
    text: "hello there",
    model: "qwen3-4b-q4_k_m",
    agentName: null,
    config: { disableThinking: true, inferenceScope: "dictationCleanup" },
    ctx,
  });

  const [userContent, model, , config] = calls[0];
  assert.equal(model, "qwen3-4b-q4_k_m");
  assert.equal(userContent, wrapCleanupTranscript("hello there"));
  assert.equal(config.systemPrompt, CLEANUP_PROMPT);
  assert.deepEqual(config.params, {
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("local.ts: an agent call keeps its own systemPrompt and shapes 0.3", async (t) => {
  const { localProvider } = await loadProvider();
  const calls = stubIpc(t);

  await localProvider.call({
    text: "do the thing",
    model: "gemma-4-e4b-it-qat-q4_0",
    agentName: "Aria",
    config: { systemPrompt: "You are an agent.", disableThinking: true },
    ctx,
  });

  const [userContent, , , config] = calls[0];
  assert.equal(userContent, "do the thing");
  assert.equal(config.systemPrompt, "You are an agent.");
  assert.deepEqual(config.params, { temperature: 0.3 });
});

test("local.ts: explicit maxTokens becomes params.max_tokens; absent leaves the key to the bridge", async (t) => {
  const { localProvider } = await loadProvider();
  const calls = stubIpc(t);

  await localProvider.call({
    text: "a",
    model: "qwen3-4b-q4_k_m",
    agentName: null,
    config: { maxTokens: 999 },
    ctx,
  });
  await localProvider.call({
    text: "a",
    model: "qwen3-4b-q4_k_m",
    agentName: null,
    config: {},
    ctx,
  });

  assert.equal(calls[0][3].params.max_tokens, 999);
  assert.ok(
    !("max_tokens" in calls[1][3].params),
    "undefined maxTokens must not become an own key"
  );
});

test("local.ts: the caller's config still travels over the IPC beside params", async (t) => {
  const { localProvider } = await loadProvider();
  const calls = stubIpc(t);

  await localProvider.call({
    text: "edit",
    model: "qwen3-4b-q4_k_m",
    agentName: null,
    config: {
      systemPrompt: "Edit the selection.",
      temperature: 0.2,
      maxTokens: 8192,
      requireCompleteOutput: true,
      disableThinking: true,
      inferenceScope: "dictationAgent",
    },
    ctx,
  });

  const config = calls[0][3];
  assert.equal(config.requireCompleteOutput, true);
  assert.equal(config.disableThinking, true);
  assert.equal(config.inferenceScope, "dictationAgent");
  assert.deepEqual(config.params, {
    temperature: 0.2,
    max_tokens: 8192,
    chat_template_kwargs: { enable_thinking: false },
  });
});
