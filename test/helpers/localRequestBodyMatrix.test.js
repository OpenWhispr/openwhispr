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
  assert.deepEqual(config.params, {
    temperature: 0.3,
    chat_template_kwargs: { enable_thinking: false },
  });
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

// --- Matrix: the full wire body per family × call shape (#1620 pattern) ---
//
// Every row is a literal expectation, never re-derived from the shaper, so a
// changed family fact, dialect, or registry flag surfaces here as a one-line
// diff. deepEqual on the whole body asserts absence too: no top-level
// reasoning_effort, no Ollama `think`, no chat_template_kwargs where the model
// has none.

const { setupLocalChain } = require("./harness/localChain");
const modelRegistryData = require("../../src/models/modelRegistryData.json");

// Not in the registry. modelManagerBridge would reject it before the wire
// today; the row pins the renderer's fail-safe (suppress when the model is
// unknown) for the day a non-registry GGUF can be served, by letting the
// manager know a model the shaper does not.
const UNKNOWN = { id: "some-custom-model-q4", fileName: "some-custom-model-q4.gguf" };

// [modelId, kwargs when the disable-thinking toggle is on (default), kwargs
// when it is off on a deterministic shape]. `enable_thinking` is llama.cpp's
// generic switch and goes out on every local model when the toggle is on —
// llama-server decides "think by default" per template on its own (Gemma 4 and
// Qwen3 do; b9763 --reasoning auto) and ignores the kwarg for templates that
// don't read it, so the registry's supportsThinking never gates it here. The
// gpt-oss "low" floor/pin is the only family effort llama-server can read.
const MODELS = [
  ["qwen3-4b-q4_k_m", { enable_thinking: false }, null],
  ["qwen3.5-4b-q4_k_m", { enable_thinking: false }, null],
  ["qwen2.5-3b-instruct-q5_k_m", { enable_thinking: false }, null],
  ["gemma-4-e4b-it-qat-q4_0", { enable_thinking: false }, null],
  ["gemma-3-4b-it-q4_k_m", { enable_thinking: false }, null],
  ["lfm2.5-1.2b-instruct-q4_k_m", { enable_thinking: false }, null],
  ["llama-3.2-3b-instruct-q4_k_m", { enable_thinking: false }, null],
  ["mistral-nemo-12b-instruct-q4_k_m", { enable_thinking: false }, null],
  [
    "gpt-oss-20b-mxfp4",
    { enable_thinking: false, reasoning_effort: "low" },
    { reasoning_effort: "low" },
  ],
  [UNKNOWN.id, { enable_thinking: false }, null],
];

const AGENT_PROMPT = "You are an agent.";
const TRANSLATE_PROMPT = "Translate to Spanish.";
const FORMAT_PROMPT = "Format these notes.";
const EDIT_PROMPT = "Edit the selection.";

// Call shapes as the real callers build them (audioManager, the dictation
// inference helpers, actionProcessingStore, the selection-edit path), with the
// body each must produce. Texts stay short so the bridge's length-based token
// fallback resolves to its 512 floor.
const SHAPES = [
  {
    name: "cleanup",
    text: "hello there",
    config: { disableThinking: true, inferenceScope: "dictationCleanup" },
    expect: {
      systemPrompt: CLEANUP_PROMPT,
      wrapped: true,
      temperature: 0,
      max_tokens: 512,
      kwargs: "suppressed",
    },
  },
  {
    name: "agent",
    text: "do the thing",
    config: { systemPrompt: AGENT_PROMPT, disableThinking: true, inferenceScope: "dictationAgent" },
    expect: { systemPrompt: AGENT_PROMPT, temperature: 0.3, max_tokens: 512, kwargs: "suppressed" },
  },
  {
    name: "translation",
    text: "hello there",
    config: {
      systemPrompt: TRANSLATE_PROMPT,
      disableThinking: true,
      inferenceScope: "dictationTranslation",
      language: "es",
    },
    expect: {
      systemPrompt: TRANSLATE_PROMPT,
      temperature: 0.3,
      max_tokens: 512,
      kwargs: "suppressed",
    },
  },
  {
    name: "note-format",
    text: "- item one\n- item two",
    config: {
      systemPrompt: FORMAT_PROMPT,
      temperature: 0.3,
      disableThinking: true,
      inferenceScope: "noteFormatting",
    },
    expect: {
      systemPrompt: FORMAT_PROMPT,
      temperature: 0.3,
      max_tokens: 512,
      kwargs: "suppressed",
    },
  },
  {
    name: "selection-edit",
    text: "make it shorter",
    config: {
      systemPrompt: EDIT_PROMPT,
      temperature: 0.2,
      maxTokens: 8192,
      requireCompleteOutput: true,
      disableThinking: true,
      inferenceScope: "dictationAgent",
    },
    expect: {
      systemPrompt: EDIT_PROMPT,
      temperature: 0.2,
      max_tokens: 8192,
      kwargs: "suppressed",
      requireCompleteOutput: true,
    },
  },
  {
    name: "cleanup, thinking allowed",
    text: "hello there",
    config: { disableThinking: false, inferenceScope: "dictationCleanup" },
    expect: {
      systemPrompt: CLEANUP_PROMPT,
      wrapped: true,
      temperature: 0,
      max_tokens: 512,
      kwargs: "pinOnly",
    },
  },
];

async function setupPathA(t) {
  const chain = await setupLocalChain(t);
  // Same contract as ipcHandlers' process-local-reasoning handler.
  stubIpc(t, (text, modelId, _agentName, config) =>
    chain.bridge.processText(text, modelId, config).then(
      (out) => ({ success: true, text: out }),
      (error) => ({ success: false, error: error.message })
    )
  );
  const { localProvider } = await loadProvider();
  const { wrapCleanupTranscript } = await loadPrompts();
  return { ...chain, localProvider, wrapCleanupTranscript };
}

async function useMatrixModel(chain, modelId) {
  if (modelId !== UNKNOWN.id) return chain.useModel(modelId);
  await chain.useModel(UNKNOWN);
  const original = chain.modelManager.findModelById.bind(chain.modelManager);
  chain.modelManager.findModelById = (id) =>
    id === UNKNOWN.id
      ? { model: { ...UNKNOWN, name: "Custom" }, provider: { id: "custom" } }
      : original(id);
  return UNKNOWN.id;
}

test("matrix: an omitted disableThinking flag preserves the local off-by-default contract", async (t) => {
  const chain = await setupPathA(t);
  const modelId = await chain.useModel("qwen3.5-4b-q4_k_m");

  await chain.localProvider.call({
    text: "hello there",
    model: modelId,
    agentName: null,
    config: {},
    ctx,
  });

  assert.deepEqual(chain.requests[0], {
    messages: [
      { role: "system", content: CLEANUP_PROMPT },
      { role: "user", content: chain.wrapCleanupTranscript("hello there") },
    ],
    temperature: 0,
    max_tokens: 512,
    chat_template_kwargs: { enable_thinking: false },
    stream: false,
  });
});

for (const [modelId, suppressedKwargs, pinOnlyKwargs] of MODELS) {
  test(`matrix: ${modelId}`, async (t) => {
    const chain = await setupPathA(t);
    await useMatrixModel(chain, modelId);

    for (const shape of SHAPES) {
      await t.test(shape.name, async () => {
        const before = chain.requests.length;
        await chain.localProvider.call({
          text: shape.text,
          model: modelId,
          agentName: null,
          config: shape.config,
          ctx,
        });

        assert.equal(chain.requests.length, before + 1, "exactly one request reaches llama-server");
        const kwargs = shape.expect.kwargs === "suppressed" ? suppressedKwargs : pinOnlyKwargs;
        assert.deepEqual(chain.requests[before], {
          messages: [
            { role: "system", content: shape.expect.systemPrompt },
            {
              role: "user",
              content: shape.expect.wrapped ? chain.wrapCleanupTranscript(shape.text) : shape.text,
            },
          ],
          temperature: shape.expect.temperature,
          max_tokens: shape.expect.max_tokens,
          ...(kwargs ? { chat_template_kwargs: kwargs } : {}),
          stream: false,
        });
        assert.equal(
          Boolean(chain.inferenceCalls[before].requireCompleteOutput),
          Boolean(shape.expect.requireCompleteOutput),
          "requireCompleteOutput must reach llamaServer.inference exactly for selection edits"
        );
      });
    }
  });
}

test("matrix: an unshaped caller (no params) gets the same legacy body for every model", async (t) => {
  const chain = await setupPathA(t);

  for (const [modelId] of MODELS) {
    await useMatrixModel(chain, modelId);
    const before = chain.requests.length;
    await chain.bridge.processText("hello there", modelId, {});
    assert.deepEqual(
      chain.requests[before],
      {
        messages: [
          { role: "system", content: "" },
          { role: "user", content: "hello there" },
        ],
        temperature: 0.7,
        max_tokens: 512,
        chat_template_kwargs: { enable_thinking: false },
        stream: false,
      },
      modelId
    );
  }
});

// The flag no longer gates the local off switch (see MODELS), but it still
// drives the settings toggle and every other provider's suppression, and it is
// simply true for these families: Qwen3/3.5 and gpt-oss by design, Gemma 4 via
// its `<|think|>` template variable (which llama-server turns on by default).
test("matrix guard: every registry model of a thinking family is flagged supportsThinking", () => {
  const thinkingFamily = /qwen3|gpt-oss|gemma-4/;
  const offenders = [];
  for (const provider of modelRegistryData.localProviders) {
    for (const model of provider.models) {
      if (thinkingFamily.test(model.id) && model.supportsThinking !== true)
        offenders.push(model.id);
    }
  }
  assert.deepEqual(offenders, [], "these ids would hide the thinking toggle for a thinking model");
});
