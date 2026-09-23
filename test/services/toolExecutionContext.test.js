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
    onClipboardReserved() {},
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
  let reservations = 0;
  const scope = createToolExecutionScope({
    onApprovalRequested: () => {
      approvals += 1;
    },
    onClipboardReserved: () => {
      reservations += 1;
    },
  });
  const first = scope.createContext("call-a");
  const second = scope.createContext("call-b");

  assert.equal(first.toolCallId, "call-a");
  assert.equal(first.signal, second.signal);
  assert.equal(first.signal.aborted, false);
  first.onApprovalRequested();
  second.onClipboardReserved();
  assert.equal(approvals, 1);
  assert.equal(reservations, 1);

  scope.abort();
  scope.abort();
  assert.equal(second.signal.aborted, true);
});

test("a scope without handlers ignores approval and clipboard notices", async () => {
  const { createToolExecutionScope } = await loadScope();
  const context = createToolExecutionScope().createContext("call-c");
  assert.doesNotThrow(() => context.onApprovalRequested());
  assert.doesNotThrow(() => context.onClipboardReserved());
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
