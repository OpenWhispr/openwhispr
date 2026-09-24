const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Mirrors the BYOK/local "tool-result" branch of ReasoningService.processTextStreamingAI:
// a successful tool's object/array output must be forwarded as `metadata` on the
// yielded `tool_result` chunk (the way the OpenWhispr Cloud path already does), so
// tool-result cards (e.g. note cards) render for BYOK and local models too.

function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-tool-metadata-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-4b-q4_k_m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function createOpenAiSseResponse(chunks, { finishReason = "stop", toolCall } = {}) {
  const events = chunks
    .map((content) => `data: ${JSON.stringify(createOpenAiChunk({ content }))}\n\n`)
    .join("");
  const toolEvent = toolCall
    ? `data: ${JSON.stringify(
        createOpenAiChunk({
          tool_calls: [
            {
              index: 0,
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.arguments },
            },
          ],
        })
      )}\n\n`
    : "";
  const finishEvent = `data: ${JSON.stringify(createOpenAiChunk({}, finishReason))}\n\n`;
  return new Response(`${events}${toolEvent}${finishEvent}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function loadReasoningService(t, cachePrefix) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  t.after(() => reasoningService.destroy());
  return { reasoningService, vite };
}

async function collectAllChunks(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function runToolMetadataScenario(t, cachePrefix, toolExecute) {
  const { reasoningService, vite } = await loadReasoningService(t, cachePrefix);
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "test_tool",
    description: "Test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: toolExecute,
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return createOpenAiSseResponse([], {
        finishReason: "tool_calls",
        toolCall: { id: "call-test", name: "test_tool", arguments: "{}" },
      });
    }
    return createOpenAiSseResponse(["Answer"]);
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    registry.toAISDKFormat()
  );

  const chunks = await collectAllChunks(stream);
  const toolResult = chunks.find((chunk) => chunk.type === "tool_result");
  assert.ok(toolResult, "expected a tool_result chunk");
  return toolResult;
}

test("a successful object tool output is forwarded as metadata", async (t) => {
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-object-test-",
    async () => ({
      success: true,
      data: { id: 42, title: "Q3 notes" },
      displayText: "Created note",
    })
  );

  assert.deepEqual(toolResult.metadata, { id: 42, title: "Q3 notes" });
});

test("a successful array tool output (search results) is forwarded as metadata", async (t) => {
  const results = [
    { id: 1, title: "First" },
    { id: 2, title: "Second" },
  ];
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-array-test-",
    async () => ({
      success: true,
      data: results,
      displayText: "Found 2 notes",
    })
  );

  assert.deepEqual(toolResult.metadata, results);
});

test("a failed tool output yields no metadata and keeps the error as displayText", async (t) => {
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-error-test-",
    async () => ({
      success: false,
      data: null,
      displayText: "Something failed",
    })
  );

  assert.equal(toolResult.metadata, undefined);
  assert.equal(toolResult.displayText, "Something failed");
});

test("a successful string tool output yields no metadata", async (t) => {
  const toolResult = await runToolMetadataScenario(
    t,
    "openwhispr-tool-metadata-string-test-",
    async () => ({
      success: true,
      data: "plain string result",
      displayText: "Done",
    })
  );

  assert.equal(toolResult.metadata, undefined);
  assert.equal(toolResult.displayText, "plain string result");
});
