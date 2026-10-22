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

test("a failed tool step is flagged as an error, and a cut-short run ends in tool-calls", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  const toolCall = (id) =>
    groqChunk({
      tool_calls: [
        { index: 0, id, type: "function", function: { name: "lookup", arguments: "{}" } },
      ],
    });
  // Twenty steps that all end in a tool call: the cap stops the run.
  stubFetch(
    t,
    Array.from({ length: 20 }, (_, i) => () => sse(toolCall(`c${i}`), groqChunk({}, "tool_calls")))
  );
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
  assert.equal(results.length, 20);
  assert.ok(results.every((result) => result.isError === true));
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

test("a cloud run whose every step calls a tool ends in tool-calls", async (t) => {
  const bridge = cloudBridge();
  const { reasoningService } = await loadReasoningService(t, { electronAPI: bridge.electronAPI });
  const output = collect(
    reasoningService.processTextStreamingCloud([{ role: "user", content: "Loop" }], {
      systemPrompt: "Answer.",
      tools: [{ name: "lookup", description: "Look up", parameters: {} }],
      executeToolCall: async () => ({ data: "ok", displayText: "ok" }),
    })
  );
  for (let step = 0; step < 20; step++) {
    await settle();
    bridge.step([{ type: "tool_call", id: `c${step}`, name: "lookup", arguments: "{}" }]);
  }
  const chunks = await output;
  assert.deepEqual(chunks.at(-1), { type: "done", finishReason: "tool-calls" });
});

test("a provider failure streamed as a plain object keeps its message", async (t) => {
  const { reasoningService } = await loadReasoningService(t, {
    electronAPI: { getGroqKey: async () => "gsk_test" },
  });
  stubFetch(t, [
    () =>
      new Response(
        `data: ${JSON.stringify({
          error: {
            message: "Failed to call a function. Please adjust your prompt.",
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
      const text = JSON.stringify({ message: error.message, details: error.technicalDetails });
      assert.match(text, /Failed to call a function/);
      assert.doesNotMatch(text, /object Object/);
      return true;
    }
  );
});
