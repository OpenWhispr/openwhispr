const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function createRawSseResponse(chunks, { includeDone = true } = {}) {
  const events = chunks
    .map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    .join("");
  const done = includeDone ? "data: [DONE]\n\n" : "";
  return new Response(`${events}${done}`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createOpenAiChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl-streaming-think-test",
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

async function loadReasoningService(t, cachePrefix, { window = {} } = {}) {
  installBrowserGlobals(t, { window });
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  t.after(() => reasoningService.destroy());
  return { reasoningService, vite };
}

async function collectRawText(stream) {
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

async function collectAgentText(stream) {
  let output = "";
  for await (const chunk of stream) {
    if (chunk.type === "content") output += chunk.text;
  }
  return output;
}

test("raw self-hosted streaming filters split tags and flushes visible trailing text", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-raw-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    createRawSseResponse(["<thi", "nk>hidden</thi", "nk>Answer<"]);

  const stream = reasoningService.processTextStreaming(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    }
  );

  assert.equal(await collectRawText(stream), "Answer<");
});

test("raw self-hosted streaming flushes visible trailing text at body EOF", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-raw-streaming-think-eof-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createRawSseResponse(["Answer<"], { includeDone: false });

  const stream = reasoningService.processTextStreaming(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    }
  );

  assert.equal(await collectRawText(stream), "Answer<");
});

test("tool-enabled self-hosted streaming filters nested tags", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-tool-streaming-think-test-"
  );
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "No-op test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ success: true, data: "ok", displayText: "ok" }),
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    createOpenAiSseResponse(["<thi", "nk>a<think>b</think>c</thi", "nk>Answer"]);

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

  assert.equal(await collectAgentText(stream), "Answer");
});

test("tool-loop filtering resets after an unterminated reasoning block", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-tool-step-streaming-think-test-"
  );
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const registry = new ToolRegistry();
  registry.register({
    name: "noop",
    description: "No-op test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ success: true, data: "ok", displayText: "ok" }),
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return createOpenAiSseResponse(["<think>secret"], {
        finishReason: "tool_calls",
        toolCall: { id: "call-noop", name: "noop", arguments: "{}" },
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

  assert.equal(await collectAgentText(stream), "Answer");
  assert.equal(fetchCalls, 2);
});

for (const terminalType of ["abort", "error"]) {
  test(`tool-enabled streaming does not flush buffered text after ${terminalType}`, async (t) => {
    const { reasoningService } = await loadReasoningService(
      t,
      `openwhispr-${terminalType}-streaming-think-test-`
    );
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    let failResponse;
    globalThis.fetch = async (_input, init) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(createOpenAiChunk({ content: "Answer<thi" }))}\n\n`
            )
          );
          failResponse = () => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ error: { message: "stream failed" } })}\n\n`
              )
            );
            controller.close();
          };
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
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
      {}
    );

    const first = await stream.next();
    assert.deepEqual(first.value, { type: "content", text: "Answer" });
    if (terminalType === "abort") reasoningService.cancelActiveStream();
    else failResponse();
    assert.equal(await collectAgentText(stream), "");
  });
}

test("self-hosted streaming preserves think tags when thinking is enabled", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-enabled-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createOpenAiSseResponse(["<think>visible</think>Answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: false,
    },
    {}
  );

  assert.equal(await collectAgentText(stream), "<think>visible</think>Answer");
});

test("non-local streaming remains unfiltered", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-streaming-think-test-",
    { window: { electronAPI: { getGroqKey: async () => "test-key" } } }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createOpenAiSseResponse(["<think>visible</think>Answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "llama-3.3-70b-versatile",
    "groq",
    { systemPrompt: "Answer the user.", disableThinking: true },
    {}
  );

  assert.equal(await collectAgentText(stream), "<think>visible</think>Answer");
});
