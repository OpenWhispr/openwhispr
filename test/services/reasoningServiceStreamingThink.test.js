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

function createAgentStreamBridge() {
  const startCalls = [];
  const cancelCalls = [];
  const listeners = { chunk: null, error: null, end: null };
  const cleanupCounts = { chunk: 0, error: 0, end: 0 };
  const subscribe = (kind, callback) => {
    listeners[kind] = callback;
    return () => {
      cleanupCounts[kind] += 1;
      if (listeners[kind] === callback) listeners[kind] = null;
    };
  };

  return {
    electronAPI: {
      startAgentStream: (...args) => startCalls.push(args),
      cancelAgentStream: (requestId) => cancelCalls.push(requestId),
      onAgentStreamChunk: (callback) => subscribe("chunk", callback),
      onAgentStreamError: (callback) => subscribe("error", callback),
      onAgentStreamEnd: (callback) => subscribe("end", callback),
    },
    startCalls,
    cancelCalls,
    cleanupCounts,
    emitChunk: (payload) => listeners.chunk?.(payload),
    emitEnd: (payload) => listeners.end?.(payload),
  };
}

const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("raw self-hosted streaming filters split tags and flushes visible trailing text", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-raw-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createRawSseResponse(["<thi", "nk>hidden</thi", "nk>Answer<"]);

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

test("tool-enabled streaming does not flush buffered text after abort", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-abort-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify(createOpenAiChunk({ content: "Answer<thi" }))}\n\n`
          )
        );
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
  reasoningService.cancelActiveStream();
  assert.equal(await collectAgentText(stream), "");
});

test("cancelling during local model setup stops before streaming begins", async (t) => {
  let resolveServer;
  let serverStarted = false;
  const serverReady = new Promise((resolve) => {
    resolveServer = resolve;
  });
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-model-setup-cancel-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: () => {
            serverStarted = true;
            return serverReady;
          },
        },
      },
    }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => createOpenAiSseResponse(["late answer"]);

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "local",
    { systemPrompt: "Answer the user.", disableThinking: true },
    {}
  );
  const first = stream.next();
  for (let i = 0; i < 50 && !serverStarted; i++) await waitForMicrotasks();
  assert.equal(serverStarted, true, "fixture setup: local model setup must be pending");

  reasoningService.cancelActiveStream();
  resolveServer({ success: true, port: 11434 });

  assert.deepEqual(await first, {
    value: { type: "done", finishReason: "stop" },
    done: false,
  });
  assert.equal((await stream.next()).done, true);
});

test("cancelling tool-ineligible local setup prevents raw streaming", async (t) => {
  let resolveServer;
  let serverStarted = false;
  const serverReady = new Promise((resolve) => {
    resolveServer = resolve;
  });
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-tool-ineligible-model-setup-cancel-test-",
    {
      window: {
        electronAPI: {
          llamaServerStart: () => {
            serverStarted = true;
            return serverReady;
          },
        },
      },
    }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return createOpenAiSseResponse(["late answer"]);
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-1.7b-q4_k_m",
    "local",
    { systemPrompt: "Answer the user.", disableThinking: true },
    undefined
  );
  const first = stream.next();
  for (let i = 0; i < 50 && !serverStarted; i++) await waitForMicrotasks();
  assert.equal(serverStarted, true, "fixture setup: raw model setup must be pending");

  reasoningService.cancelActiveStream();
  resolveServer({ success: true, port: 11434 });

  const firstResult = await first;
  const chunks = firstResult.done ? [] : [firstResult.value];
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(chunks, [{ type: "done", finishReason: "stop" }]);
  assert.equal(fetchCalls, 0);
});

test("cancelling a raw stream after its reader starts ends normally", async (t) => {
  const { reasoningService } = await loadReasoningService(t, "openwhispr-raw-reader-cancel-test-");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let readerStarted = false;
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      pull() {
        readerStarted = true;
      },
      start(controller) {
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
    "qwen3-1.7b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    undefined
  );
  const output = collectAgentText(stream);
  for (let i = 0; i < 50 && !readerStarted; i++) await waitForMicrotasks();
  assert.equal(readerStarted, true, "fixture setup: the response reader must be pending");

  reasoningService.cancelActiveStream();

  assert.equal(await output, "");
});

test("a timeout-owned abort during raw response reading remains a timeout error", async (t) => {
  const { reasoningService } = await loadReasoningService(t, "openwhispr-raw-reader-timeout-test-");
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  });
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, delay === 60_000 ? 0 : delay, ...args);
  globalThis.fetch = async (_input, init) => {
    const body = new ReadableStream({
      start(controller) {
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
    "qwen3-1.7b-q4_k_m",
    "lan",
    {
      systemPrompt: "Answer the user.",
      lanUrl: "http://127.0.0.1:11434/v1",
      disableThinking: true,
    },
    undefined
  );

  await assert.rejects(collectAgentText(stream), /Streaming request timed out/);
});

// Was "does not flush buffered text after error" and asserted the stream
// silently ended with "". A provider-reported error part must now reject the
// generator instead; buffered text must still never leak into that rejection.
test("tool-enabled streaming rejects instead of flushing buffered text after a stream error", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-error-streaming-think-test-"
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let failResponse;
  globalThis.fetch = async () => {
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
            encoder.encode(`data: ${JSON.stringify({ error: { message: "stream failed" } })}\n\n`)
          );
          controller.close();
        };
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
  failResponse();

  let received = "";
  await assert.rejects(
    (async () => {
      for await (const chunk of stream) {
        if (chunk.type === "content") received += chunk.text;
      }
    })()
  );
  assert.equal(received, "");
});

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

test("chat cancellation leaves single-shot reasoning alive until all requests are cancelled", async (t) => {
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-non-streaming-reason-cancel-test-",
    { window: { electronAPI: { getGroqKey: async () => "test-key" } } }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestStarted = false;
  let requestSignal;
  let fetchCalls = 0;
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1;
    requestStarted = true;
    requestSignal = init?.signal;
    return await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true }
      );
    });
  };

  const reasoning = reasoningService.processText(
    "clean this text",
    "llama-3.3-70b-versatile",
    null,
    { provider: "groq" }
  );
  while (!requestStarted) await waitForMicrotasks();
  const cancelled = assert.rejects(reasoning, /cancelled/i);

  reasoningService.cancelActiveStream();
  assert.equal(requestSignal?.aborted, false);

  reasoningService.cancelAllRequests();

  await cancelled;
  assert.equal(fetchCalls, 1);
});

test("cloud agent streaming correlates events to the initiating request", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-correlation-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud([{ role: "user", content: "hello" }], {
    systemPrompt: "Answer the user.",
  });
  let firstSettled = false;
  const first = stream.next().then((result) => {
    firstSettled = true;
    return result;
  });
  await waitForMicrotasks();

  assert.equal(bridge.startCalls.length, 1);
  const [requestId] = bridge.startCalls[0];
  assert.equal(typeof requestId, "string");
  assert.ok(requestId.length > 0);

  bridge.emitChunk({
    requestId: "another-request",
    chunk: { type: "content", text: "wrong" },
  });
  await waitForMicrotasks();
  assert.equal(firstSettled, false);

  bridge.emitChunk({ requestId, chunk: { type: "content", text: "right" } });
  assert.deepEqual(await first, { value: { type: "content", text: "right" }, done: false });

  const end = stream.next();
  bridge.emitEnd({ requestId });
  assert.deepEqual(await end, {
    value: { type: "done", finishReason: "stop" },
    done: false,
  });
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(bridge.cleanupCounts, { chunk: 1, error: 1, end: 1 });
});

test("cancelling a cloud agent stream aborts main and ends the local generator", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud([{ role: "user", content: "hello" }], {
    systemPrompt: "Answer the user.",
  });
  const pending = stream.next();
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];

  reasoningService.cancelActiveStream();

  assert.deepEqual(bridge.cancelCalls, [requestId]);
  assert.equal((await pending).done, true);
  assert.deepEqual(bridge.cleanupCounts, { chunk: 1, error: 1, end: 1 });
});

test("cancelling a cloud stream before its first next prevents the request", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-pre-next-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud([{ role: "user", content: "hello" }], {
    systemPrompt: "Answer the user.",
  });

  reasoningService.cancelActiveStream();
  const first = stream.next();
  await waitForMicrotasks();
  const startedRequests = bridge.startCalls.length;
  if (startedRequests > 0) reasoningService.cancelActiveStream();

  assert.equal(startedRequests, 0);
  assert.equal((await first).done, true);
});

test("cancelling a cloud agent stream drops chunks already queued locally", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-queued-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  const stream = reasoningService.processTextStreamingCloud([{ role: "user", content: "hello" }], {
    systemPrompt: "Answer the user.",
  });
  const first = stream.next();
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];

  bridge.emitChunk({ requestId, chunk: { type: "content", text: "first" } });
  bridge.emitChunk({ requestId, chunk: { type: "content", text: "queued" } });
  assert.deepEqual(await first, { value: { type: "content", text: "first" }, done: false });

  reasoningService.cancelActiveStream();

  assert.equal((await stream.next()).done, true);
  bridge.emitChunk({ requestId, chunk: { type: "content", text: "late" } });
  assert.equal((await stream.next()).done, true);
});

test("cancelling during a cloud tool execution prevents results and later model steps", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService } = await loadReasoningService(
    t,
    "openwhispr-cloud-agent-tool-cancel-test-",
    { window: { electronAPI: bridge.electronAPI } }
  );
  let resolveTool;
  let toolStarted = false;
  const toolResult = new Promise((resolve) => {
    resolveTool = resolve;
  });
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "create a note" }],
    {
      systemPrompt: "Use tools.",
      tools: [{ name: "create_note", description: "Create a note", parameters: {} }],
      executeToolCall: async () => {
        toolStarted = true;
        return toolResult;
      },
    }
  );
  const first = stream.next();
  await waitForMicrotasks();
  const [requestId] = bridge.startCalls[0];
  bridge.emitChunk({
    requestId,
    chunk: { type: "tool_call", id: "call-1", name: "create_note", arguments: "{}" },
  });
  assert.deepEqual(await first, {
    value: {
      type: "tool_calls",
      calls: [{ id: "call-1", name: "create_note", arguments: "{}" }],
    },
    done: false,
  });

  const pending = stream.next();
  bridge.emitEnd({ requestId });
  while (!toolStarted) await waitForMicrotasks();

  reasoningService.cancelActiveStream();
  resolveTool({ data: "created", displayText: "Created note" });

  assert.equal((await pending).done, true);
  assert.equal(bridge.startCalls.length, 1);
});

test("a provider error part rejects the agent stream instead of ending it silently", async (t) => {
  const { reasoningService, vite } = await loadReasoningService(
    t,
    "openwhispr-stream-error-part-test-"
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
  // streamText never throws on an HTTP failure; it emits an `error` part and
  // closes the stream. The generator must surface that as a rejection.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }),
      { status: 401, headers: { "content-type": "application/json" } }
    );

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "hello" }],
    "qwen3-4b-q4_k_m",
    "lan",
    { systemPrompt: "Answer the user.", lanUrl: "http://127.0.0.1:11434/v1", disableThinking: true },
    registry.toAISDKFormat()
  );

  await assert.rejects(collectAgentText(stream), /Incorrect API key/);
});
