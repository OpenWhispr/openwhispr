const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// What the agent streams beyond text: reasoning, failed tool steps, the
// step cap, screenshots for later steps, and the cloud loop's interim text.
async function loadReasoningService(t, { electronAPI = {} } = {}) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-turns-rs-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());
  return { reasoningService, vite };
}

function groqChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-turns",
    object: "chat.completion.chunk",
    created: 1,
    model: "openai/gpt-oss-120b",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sse(...chunks) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function stubFetch(t, responses) {
  const bodies = [];
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return responses.shift()();
  };
  return bodies;
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const groqToolCall = (id) =>
  groqChunk({
    tool_calls: [{ index: 0, id, type: "function", function: { name: "lookup", arguments: "{}" } }],
  });

async function groqTools(vite, tool) {
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "lookup",
    description: "Look something up",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: tool,
  });
  return registry.toAISDKFormat();
}

const GROQ_CONFIG = { systemPrompt: "Answer the user." };
// Tool steps a turn may take before it has to answer.
const STEP_CAP = 20;

test("Groq reasoning streams as reasoning, apart from the answer", async (t) => {
  const { reasoningService } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  stubFetch(t, [
    () =>
      sse(
        groqChunk({ role: "assistant", reasoning: "Think " }),
        groqChunk({ reasoning: "briefly." }),
        groqChunk({ content: "Hello." }),
        groqChunk({}, "stop")
      ),
  ]);
  const chunks = await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "openai/gpt-oss-120b",
      "groq",
      GROQ_CONFIG
    )
  );
  assert.equal(
    chunks
      .filter((c) => c.type === "reasoning")
      .map((c) => c.text)
      .join(""),
    "Think briefly."
  );
  assert.equal(
    chunks
      .filter((c) => c.type === "content")
      .map((c) => c.text)
      .join(""),
    "Hello."
  );
});

test("a failed tool step is flagged as an error, and a cut-short run answers without tools", async (t) => {
  const { STEP_LIMIT_NOTE } = await import("../../src/config/prompts.ts");
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  // Every step ends in a tool call until the cap stops the run; one more
  // request, with no tools, gives the answer.
  const bodies = stubFetch(t, [
    ...Array.from(
      { length: STEP_CAP },
      (_, i) => () => sse(groqToolCall(`c${i}`), groqChunk({}, "tool_calls"))
    ),
    () => sse(groqChunk({ content: "The lookups failed." }), groqChunk({}, "stop")),
  ]);
  const tools = await groqTools(vite, async () => ({
    success: false,
    data: null,
    displayText: "Lookup failed",
  }));
  const chunks = await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "openai/gpt-oss-120b",
      "groq",
      GROQ_CONFIG,
      tools
    )
  );
  const results = chunks.filter((c) => c.type === "tool_result");
  assert.equal(results.length, STEP_CAP);
  assert.ok(results.every((result) => result.isError === true));
  assert.equal(bodies.length, STEP_CAP + 1);
  assert.equal(bodies.at(-1).tool_choice, "none");
  assert.deepEqual(bodies.at(-1).messages.at(-1), { role: "user", content: STEP_LIMIT_NOTE });
  assert.deepEqual(chunks.slice(-2), [
    { type: "content", text: "The lookups failed." },
    { type: "done", finishReason: "tool-calls" },
  ]);
});

// A server that ignores tool_choice "none" (a LAN or custom one) still can't
// run a tool from the answer at the cap, nor show one running.
test("a tool call in the answer at the step cap never runs", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  stubFetch(t, [
    ...Array.from(
      { length: STEP_CAP + 1 },
      (_, i) => () => sse(groqToolCall(`c${i}`), groqChunk({}, "tool_calls"))
    ),
  ]);
  let runs = 0;
  const tools = await groqTools(vite, async () => {
    runs += 1;
    return { success: true, data: "ok", displayText: "" };
  });
  const chunks = await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "openai/gpt-oss-120b",
      "groq",
      GROQ_CONFIG,
      tools
    )
  );
  assert.equal(runs, STEP_CAP);
  assert.equal(chunks.filter((chunk) => chunk.type === "tool_calls").length, STEP_CAP);
  assert.deepEqual(chunks.at(-1), { type: "done", finishReason: "tool-calls" });
});

// The answer at the cap is extra: a provider that refuses it, or one that
// can't take it, ends the turn at the cap as before.
test("a BYOK answer at the step cap that fails ends the turn at the cap", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  const bodies = stubFetch(t, [
    ...Array.from(
      { length: STEP_CAP },
      (_, i) => () => sse(groqToolCall(`c${i}`), groqChunk({}, "tool_calls"))
    ),
    () =>
      new Response(
        JSON.stringify({ error: { message: "Tools are required", type: "invalid_request_error" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      ),
  ]);
  const tools = await groqTools(vite, async () => ({ success: true, data: "ok", displayText: "" }));
  const chunks = await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "openai/gpt-oss-120b",
      "groq",
      GROQ_CONFIG,
      tools
    )
  );
  assert.equal(bodies.length, STEP_CAP + 1);
  assert.deepEqual(chunks.at(-1), { type: "done", finishReason: "tool-calls" });
  assert.equal(chunks.filter((chunk) => chunk.type === "done").length, 1);
});

test("on Anthropic the step cap ends the turn without a last answer", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getAnthropicKey: async () => "sk-ant-test" },
  });
  const toolUse = (id) =>
    sse(
      {
        type: "message_start",
        message: {
          id: `msg_${id}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name: "lookup", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" }
    );
  const bodies = stubFetch(
    t,
    Array.from({ length: STEP_CAP }, (_, i) => () => toolUse(`toolu_${i}`))
  );
  const tools = await groqTools(vite, async () => ({ success: true, data: "ok", displayText: "" }));
  const chunks = await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "claude-sonnet-4-6",
      "anthropic",
      GROQ_CONFIG,
      tools
    )
  );
  assert.equal(bodies.length, STEP_CAP);
  assert.equal(chunks.filter((chunk) => chunk.type === "tool_result").length, STEP_CAP);
  assert.deepEqual(chunks.at(-1), { type: "done", finishReason: "tool-calls" });
});

test("a screenshot attached mid-turn reaches every later step as an image", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  const bodies = stubFetch(t, [
    () =>
      sse(
        groqChunk({
          tool_calls: [
            { index: 0, id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        }),
        groqChunk({}, "tool_calls")
      ),
    () => sse(groqChunk({ content: "I see it." }), groqChunk({}, "stop")),
  ]);
  const stepImages = [];
  const tools = await groqTools(vite, async () => {
    stepImages.push({ image: "SCREEN", mediaType: "image/jpeg" });
    return { success: true, data: { status: "granted" }, displayText: "Granted" };
  });
  await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "What's on my screen?" }],
      "openai/gpt-oss-120b",
      "groq",
      { ...GROQ_CONFIG, stepImages },
      tools
    )
  );
  assert.equal(JSON.stringify(bodies[0]).includes("SCREEN"), false);
  const last = bodies[1].messages.at(-1);
  assert.equal(last.role, "user");
  assert.ok(JSON.stringify(last.content).includes("data:image/jpeg;base64,SCREEN"));
});

function cloudBridge() {
  const startCalls = [];
  const listeners = {};
  return {
    startCalls,
    electronAPI: {
      startAgentStream: (...args) => startCalls.push(args),
      cancelAgentStream() {},
      onAgentStreamChunk: (cb) => ((listeners.chunk = cb), () => {}),
      onAgentStreamError: (cb) => ((listeners.error = cb), () => {}),
      onAgentStreamEnd: (cb) => ((listeners.end = cb), () => {}),
    },
    step(chunks) {
      const [requestId] = startCalls.at(-1);
      for (const chunk of chunks) listeners.chunk({ requestId, chunk });
      listeners.end({ requestId });
    },
    fail(error) {
      const [requestId] = startCalls.at(-1);
      listeners.error({ requestId, error });
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the cloud loop keeps a step's text for the next step and flags a throwing tool", async (t) => {
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Check" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => {
        throw new Error("boom");
      },
    })
  );
  await settle();
  bridge.step([
    { type: "content", text: "Let me check." },
    { type: "tool_call", id: "c1", name: "lookup", arguments: "{}" },
  ]);
  await settle();
  bridge.step([{ type: "content", text: "It failed." }]);
  const chunks = await output;

  assert.deepEqual(
    bridge.startCalls[1][1].map((message) => [message.role, typeof message.content]),
    [
      ["user", "string"],
      ["assistant", "string"],
      ["assistant", "object"],
      ["tool", "object"],
    ]
  );
  assert.equal(bridge.startCalls[1][1][1].content, "Let me check.");
  const result = chunks.find((chunk) => chunk.type === "tool_result");
  assert.equal(result.isError, true);
  assert.deepEqual(chunks.at(-1), { type: "done", finishReason: "stop" });
});

test("a cloud run whose every step calls a tool answers once more, without tools", async (t) => {
  const { STEP_LIMIT_NOTE } = await import("../../src/config/prompts.ts");
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Loop" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => ({ data: "ok", displayText: "ok" }),
    })
  );
  for (let step = 0; step < STEP_CAP; step++) {
    await settle();
    bridge.step([{ type: "tool_call", id: `c${step}`, name: "lookup", arguments: "{}" }]);
  }
  await settle();
  bridge.step([{ type: "content", text: "Here is what I found so far." }]);
  const chunks = await output;

  assert.equal(bridge.startCalls.length, STEP_CAP + 1);
  const [, messages, options] = bridge.startCalls.at(-1);
  assert.deepEqual(messages.at(-1), { role: "user", content: STEP_LIMIT_NOTE });
  assert.equal(options.tools, undefined);
  assert.deepEqual(chunks.slice(-2), [
    { type: "content", text: "Here is what I found so far." },
    { type: "done", finishReason: "tool-calls" },
  ]);
});

test("a cloud answer at the step cap that fails ends the turn at the cap", async (t) => {
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Loop" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => ({ data: "ok", displayText: "ok" }),
    })
  );
  for (let step = 0; step < STEP_CAP; step++) {
    await settle();
    bridge.step([{ type: "tool_call", id: `c${step}`, name: "lookup", arguments: "{}" }]);
  }
  await settle();
  bridge.fail("Tool messages need tools");
  const chunks = await output;

  assert.equal(bridge.startCalls.length, STEP_CAP + 1);
  assert.deepEqual(chunks.at(-1), { type: "done", finishReason: "tool-calls" });
});

test("a cloud answer at the step cap that claims an unbacked action is flagged, not asked again", async (t) => {
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Email Gabe" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => ({ data: "ok", displayText: "ok" }),
      isUnbackedClaim: (text) => /I've sent/.test(text),
    })
  );
  for (let step = 0; step < STEP_CAP; step++) {
    await settle();
    bridge.step([{ type: "tool_call", id: `c${step}`, name: "lookup", arguments: "{}" }]);
  }
  await settle();
  bridge.step([{ type: "content", text: "Done! I've sent it." }]);
  const chunks = await output;

  assert.equal(bridge.startCalls.length, STEP_CAP + 1);
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === "unbacked_claim" || chunk.type === "done"),
    [
      { type: "unbacked_claim", retry: false },
      { type: "done", finishReason: "tool-calls" },
    ]
  );
});

test("a provider failure streamed as a plain object uses safe text and redacted diagnostics", async (t) => {
  const { reasoningService } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  stubFetch(t, [
    () =>
      new Response(
        `data: ${JSON.stringify({
          error: {
            message: "Failed to call a function. Bearer sk-fixture-secret123",
            type: "invalid_request_error",
            code: "tool_use_failed",
          },
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
  ]);
  await assert.rejects(
    collect(
      reasoningService.processTextStreamingAI(
        [{ role: "user", content: "hi" }],
        "openai/gpt-oss-120b",
        "groq",
        GROQ_CONFIG
      )
    ),
    (error) => {
      assert.equal(error.messageKey, "providerErrors.unknown");
      assert.doesNotMatch(error.message, /Failed to call a function|sk-fixture-secret123/);
      assert.match(error.technicalDetails.underlyingError, /Failed to call a function/);
      assert.match(error.technicalDetails.underlyingError, /\[redacted\]/);
      assert.doesNotMatch(
        error.technicalDetails.underlyingError,
        /sk-fixture-secret123|object Object/
      );
      assert.equal(error.cause.type, "invalid_request_error");
      return true;
    }
  );
});

// A final answer that claims an action no tool call in its turn did is asked
// again once, with a note from the user's side; the caller decides what a claim is.
const claimsSent = (text) => /I've sent/.test(text);

test("a cloud answer that claims an unbacked action is asked once more", async (t) => {
  const { CLAIM_CHECK_NOTE } = await import("../../src/config/prompts.ts");
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Email Gabe" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => ({ data: "ok", displayText: "ok" }),
      isUnbackedClaim: claimsSent,
    })
  );
  await settle();
  bridge.step([{ type: "content", text: "Done! I've sent it." }]);
  await settle();
  bridge.step([{ type: "content", text: "I haven't sent it yet. Want me to?" }]);
  const chunks = await output;

  assert.equal(bridge.startCalls.length, 2);
  assert.deepEqual(bridge.startCalls[1][1], [
    { role: "user", content: "Email Gabe" },
    { role: "assistant", content: "Done! I've sent it." },
    { role: "user", content: CLAIM_CHECK_NOTE },
  ]);
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type !== "content"),
    [
      { type: "unbacked_claim", retry: true },
      { type: "done", finishReason: "stop" },
    ]
  );
});

test("a cloud answer still claiming it after the second ask is kept and flagged", async (t) => {
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Email Gabe" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => ({ data: "ok", displayText: "ok" }),
      isUnbackedClaim: claimsSent,
    })
  );
  await settle();
  bridge.step([{ type: "content", text: "Done! I've sent it." }]);
  await settle();
  bridge.step([{ type: "content", text: "I've sent it, really." }]);
  const chunks = await output;

  assert.equal(bridge.startCalls.length, 2);
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type !== "content"),
    [
      { type: "unbacked_claim", retry: true },
      { type: "unbacked_claim", retry: false },
      { type: "done", finishReason: "stop" },
    ]
  );
});

test("a BYOK answer that claims an unbacked action is asked once more after everything it said", async (t) => {
  const { CLAIM_CHECK_NOTE } = await import("../../src/config/prompts.ts");
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  const bodies = stubFetch(t, [
    () =>
      sse(
        groqChunk({
          tool_calls: [
            { index: 0, id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } },
          ],
        }),
        groqChunk({}, "tool_calls")
      ),
    () => sse(groqChunk({ content: "Done! I've sent it." }), groqChunk({}, "stop")),
    () => sse(groqChunk({ content: "Not sent yet: want me to?" }), groqChunk({}, "stop")),
  ]);
  const tools = await groqTools(vite, async () => ({ success: true, data: "ok", displayText: "" }));
  const chunks = await collect(
    reasoningService.processTextStreamingAI(
      [{ role: "user", content: "Email Gabe" }],
      "openai/gpt-oss-120b",
      "groq",
      { ...GROQ_CONFIG, isUnbackedClaim: claimsSent },
      tools
    )
  );

  assert.equal(bodies.length, 3);
  assert.deepEqual(
    bodies[2].messages.map((message) => [message.role, message.content]),
    [
      ["user", "Email Gabe"],
      ["assistant", ""],
      ["tool", "ok"],
      ["assistant", "Done! I've sent it."],
      ["user", CLAIM_CHECK_NOTE],
    ]
  );
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === "unbacked_claim" || chunk.type === "done"),
    [
      { type: "unbacked_claim", retry: true },
      { type: "done", finishReason: "stop" },
    ]
  );
});
