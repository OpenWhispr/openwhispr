const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const loadRegistry = () => import("../../src/services/tools/ToolRegistry.ts");
const loadScope = () => import("../../src/components/chat/toolExecutionScope.ts");

function recordingTool(seen) {
  return {
    name: "record_context",
    description: "Records the context it was called with",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(args, context) {
      seen.push({ args, context });
      return { success: true, data: { ok: true }, displayText: "ok" };
    },
  };
}

test("toAISDKFormat gives each call its own tool-call id and the shared scope", async () => {
  const { ToolRegistry } = await loadRegistry();
  const seen = [];
  const registry = new ToolRegistry();
  registry.register(recordingTool(seen));
  const controller = new AbortController();
  const onApprovalRequested = () => {};
  const tools = registry.toAISDKFormat((toolCallId) => ({
    toolCallId,
    signal: controller.signal,
    onApprovalRequested,
    onHoldDelivery() {},
  }));

  await tools.record_context.execute({ a: 1 }, { toolCallId: "call-1", messages: [] });
  await tools.record_context.execute({ a: 2 }, { toolCallId: "call-2", messages: [] });

  assert.deepEqual(
    seen.map((entry) => entry.context.toolCallId),
    ["call-1", "call-2"]
  );
  assert.equal(seen[0].context.signal, controller.signal);
  assert.equal(seen[1].context.onApprovalRequested, onApprovalRequested);
});

test("toAISDKFormat reports each call's display text next to the model's output", async () => {
  const { ToolRegistry } = await loadRegistry();
  const registry = new ToolRegistry();
  registry.register(recordingTool([]));
  const shown = [];
  const tools = registry.toAISDKFormat(undefined, (toolCallId, displayText) =>
    shown.push({ toolCallId, displayText })
  );

  const output = await tools.record_context.execute({}, { toolCallId: "call-7", messages: [] });

  assert.deepEqual(output, { ok: true });
  assert.deepEqual(shown, [{ toolCallId: "call-7", displayText: "ok" }]);
});

test("toAISDKFormat without a context factory passes no context", async () => {
  const { ToolRegistry } = await loadRegistry();
  const seen = [];
  const registry = new ToolRegistry();
  registry.register(recordingTool(seen));

  await registry.toAISDKFormat().record_context.execute({}, { toolCallId: "call-3", messages: [] });

  assert.equal(seen[0].context, undefined);
});

test("a tool execution scope shares one signal and aborts it once", async () => {
  const { createToolExecutionScope } = await loadScope();
  let approvals = 0;
  let holds = 0;
  const scope = createToolExecutionScope({
    onApprovalRequested: () => {
      approvals += 1;
    },
    onHoldDelivery: () => {
      holds += 1;
    },
  });
  const first = scope.createContext("call-a");
  const second = scope.createContext("call-b");

  assert.equal(first.toolCallId, "call-a");
  assert.equal(first.signal, second.signal);
  assert.equal(first.signal.aborted, false);
  first.onApprovalRequested();
  second.onHoldDelivery();
  assert.equal(approvals, 1);
  assert.equal(holds, 1);

  scope.abort();
  scope.abort();
  assert.equal(second.signal.aborted, true);
});

test("a scope's notices do nothing once its turn has ended", async () => {
  const { createToolExecutionScope } = await loadScope();
  let notices = 0;
  const scope = createToolExecutionScope({
    onApprovalRequested: () => {
      notices += 1;
    },
    onHoldDelivery: () => {
      notices += 1;
    },
  });
  const context = scope.createContext("call-d");

  // A slow tool result arriving after Esc must not reopen a dismissed panel.
  scope.abort();
  context.onApprovalRequested();
  context.onHoldDelivery();

  assert.equal(notices, 0);
});

test("turn slots are shared by a scope's calls and start over with each turn", async () => {
  const { createToolExecutionScope } = await loadScope();
  const scope = createToolExecutionScope();
  const first = scope.createContext("call-e");
  const second = scope.createContext("call-f");

  assert.equal(first.claimTurnSlot("draft", 2), true);
  assert.equal(second.claimTurnSlot("draft", 2), true);
  assert.equal(first.claimTurnSlot("draft", 2), false);
  // Keys count separately.
  assert.equal(second.claimTurnSlot("clipboard", 1), true);
  assert.equal(createToolExecutionScope().createContext("call-g").claimTurnSlot("draft", 2), true);
});

test("executeTool settles an aborted call at once and never runs one after the abort", async () => {
  const { executeTool } = await loadRegistry();
  const { createToolExecutionScope } = await loadScope();
  let runs = 0;
  const hanging = {
    ...recordingTool([]),
    execute: () => {
      runs += 1;
      // Ignores the signal, like a fetch with no timeout; rejects much later.
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 50));
    },
  };
  const scope = createToolExecutionScope();

  const pending = executeTool(hanging, {}, scope.createContext("call-h"));
  scope.abort();
  assert.deepEqual(await pending, { success: false, data: null, displayText: "" });
  assert.deepEqual(await executeTool(hanging, {}, scope.createContext("call-i")), {
    success: false,
    data: null,
    displayText: "",
  });
  assert.equal(runs, 1);
  // The late rejection is swallowed rather than surfacing as unhandled.
  await new Promise((resolve) => setTimeout(resolve, 80));
});

test("executeTool passes results and errors through while the turn is live", async () => {
  const { executeTool } = await loadRegistry();
  const { createToolExecutionScope } = await loadScope();
  const context = createToolExecutionScope().createContext("call-j");
  assert.deepEqual(await executeTool(recordingTool([]), { a: 1 }, context), {
    success: true,
    data: { ok: true },
    displayText: "ok",
  });
  const failing = { ...recordingTool([]), execute: async () => Promise.reject(new Error("boom")) };
  await assert.rejects(executeTool(failing, {}, context), /boom/);
  assert.deepEqual(await executeTool(recordingTool([]), {}), {
    success: true,
    data: { ok: true },
    displayText: "ok",
  });
});

test("an aborted AI SDK turn ends even when a tool never settles", async () => {
  const { streamText, stepCountIs } = require("ai");
  const { MockLanguageModelV3, simulateReadableStream } = require("ai/test");
  const { ToolRegistry } = await loadRegistry();
  const { createToolExecutionScope } = await loadScope();
  const registry = new ToolRegistry();
  let started;
  const toolStarted = new Promise((resolve) => {
    started = resolve;
  });
  registry.register({
    ...recordingTool([]),
    name: "slow",
    execute: () => {
      started();
      return new Promise(() => {});
    },
  });
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-1", toolName: "slow", input: "{}" },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          },
        ],
      }),
    }),
  });
  const scope = createToolExecutionScope();
  const streamAbort = new AbortController();
  const result = streamText({
    model,
    messages: [{ role: "user", content: "hi" }],
    tools: registry.toAISDKFormat(scope.createContext),
    stopWhen: stepCountIs(5),
    abortSignal: streamAbort.signal,
  });
  const drained = (async () => {
    for await (const _chunk of result.fullStream);
  })();

  await toolStarted;
  // Let the SDK settle into waiting on the tool, as it has by the time a user
  // presses Esc; an abort in the same tick still ends the stream on its own.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // What cancelStream does: abort the tool scope and the stream.
  scope.abort();
  streamAbort.abort();
  const outcome = await Promise.race([
    drained.then(() => "ended"),
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 2000)),
  ]);
  assert.equal(outcome, "ended");
});

test("a scope without handlers ignores approval and delivery notices", async () => {
  const { createToolExecutionScope } = await loadScope();
  const context = createToolExecutionScope().createContext("call-c");
  assert.doesNotThrow(() => context.onApprovalRequested());
  assert.doesNotThrow(() => context.onHoldDelivery());
});

test("the cloud tool loop passes each call's id to executeToolCall", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tool-context-cloud-test-",
  });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  let step = 0;
  t.mock.method(reasoningService, "streamFromIPC", () => {
    step += 1;
    const events =
      step === 1
        ? [{ type: "tool_call", id: "call-9", name: "record_context", arguments: "{}" }]
        : [{ type: "content", text: "done" }];
    return {
      stream: (async function* () {
        for (const event of events) yield event;
      })(),
      wasCancelled: () => false,
    };
  });

  const received = [];
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hi" }],
    {
      systemPrompt: "s",
      tools: [{ name: "record_context", description: "d", parameters: {} }],
      executeToolCall: async (name, _args, toolCallId) => {
        received.push({ name, toolCallId });
        return { data: "ok", displayText: "ok" };
      },
    }
  );
  for await (const _chunk of stream) {
    // drain
  }

  assert.deepEqual(received, [{ name: "record_context", toolCallId: "call-9" }]);
});
