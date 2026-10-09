const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const TRANSCRIPT = "Agenda discussion. ".repeat(3000) + "The launch code is violet heron.";
const calls = Array.from({ length: 8 }, (_, index) => ({
  id: `read-${index}`,
  name: "get_note",
  arguments: JSON.stringify({
    id: 7,
    ...(index === 7 ? { transcript_query: "launch code" } : { transcript_offset: index * 500 }),
  }),
}));

function sse(call) {
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "qwen3-4b-q4_k_m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const delta = call
    ? {
        tool_calls: [
          {
            index: 0,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      }
    : { content: "violet heron" };
  return new Response(chunk(delta) + chunk({}, call ? "tool_calls" : "stop") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

for (const provider of ["local SDK", "cloud", "local SDK with standard tools"]) {
  test(`${provider}: actual repeated requests keep two bounded passages and reach tail evidence`, async (t) => {
    const requests = [];
    let onChunk;
    let onEnd;
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          getNote: async () => ({
            id: 7,
            title: "Launch",
            content: "Personal notes.",
            enhanced_content: "Agenda summary.",
            transcript: TRANSCRIPT,
          }),
          llamaServerStart: async () => ({ success: true, port: 12345 }),
          onAgentStreamChunk: (listener) => {
            onChunk = listener;
            return () => {};
          },
          onAgentStreamEnd: (listener) => {
            onEnd = listener;
            return () => {};
          },
          onAgentStreamError: () => () => {},
          startAgentStream: (requestId, messages, config) => {
            const call = calls[requests.length];
            requests.push(structuredClone({ messages, tools: config.tools }));
            queueMicrotask(() => {
              onChunk({
                requestId,
                chunk: call
                  ? { type: "tool_call", ...call }
                  : { type: "content", text: "violet heron" },
              });
              onEnd({ requestId });
            });
          },
        },
      },
    });
    const vite = await createRendererServer(t);
    const reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.after(() => reasoning.destroy());
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    usePolicyStore.setState({ status: "unmanaged", policy: null });
    const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
    const { getNoteTool } = await vite.ssrLoadModule("/services/tools/getNoteTool.ts");
    const { getAgentSystemPrompt } = await vite.ssrLoadModule("/config/prompts.ts");
    const { estimateNoteTokens } = await vite.ssrLoadModule("/helpers/noteChunking.js");
    const standardTools = provider === "local SDK with standard tools";
    const { createToolRegistry } = await vite.ssrLoadModule("/services/tools/index.ts");
    const registry = standardTools
      ? createToolRegistry({
          isSignedIn: false,
          calendarConnected: false,
          cloudBackupEnabled: false,
          webSearchEnabled: false,
          vocabulary: {
            getDictionary: () => [],
            updateDictionary() {},
            getSnippets: () => [],
            setSnippets() {},
          },
        })
      : new ToolRegistry();
    if (!standardTools) registry.register(getNoteTool);
    const systemPrompt = getAgentSystemPrompt(registry.getAll());
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "What is the launch code?" },
    ];
    const originalFetch = global.fetch;
    t.after(() => {
      global.fetch = originalFetch;
    });
    global.fetch = async (_url, init) => {
      const call = calls[requests.length];
      requests.push(JSON.parse(init.body));
      return sse(call);
    };
    const stream =
      provider === "cloud"
        ? reasoning.processTextStreamingCloud(messages, {
            systemPrompt,
            tools: registry
              .getAll()
              .map(({ name, description, parameters }) => ({ name, description, parameters })),
            executeToolCall: async (_name, args) => {
              const result = await getNoteTool.execute(JSON.parse(args));
              return { data: JSON.stringify(result.data), displayText: result.displayText };
            },
          })
        : reasoning.processTextStreamingAI(
            messages,
            "qwen3-4b-q4_k_m",
            "local",
            { systemPrompt, ...(standardTools ? {} : { maxTokens: 512 }) },
            registry.toAISDKFormat()
          );
    let answer = "";
    for await (const chunk of stream) if (chunk.type === "content") answer += chunk.text;
    assert.equal(answer, "violet heron");
    assert.equal(requests.length, 9);
    const last = JSON.stringify(requests.at(-1));
    assert.ok(last.includes("violet heron"), "the model's final request contains late evidence");
    assert.ok(last.includes("transcript_omitted"));
    const outputReserve = standardTools ? 4096 : 512;
    const contextBudget = standardTools ? 16384 : 4096;
    for (const request of requests) {
      const serialized = JSON.stringify(request);
      assert.ok(!serialized.includes(TRANSCRIPT));
      const modelPayload = JSON.stringify({ messages: request.messages, tools: request.tools });
      // Representative retrieval-only 4K and standard-registry 16K requests.
      // Extra connectors, large notes and tokenizer differences are not covered.
      assert.ok(
        estimateNoteTokens(modelPayload) + outputReserve < contextBudget,
        `retrieval request exceeds fixture budget: ${estimateNoteTokens(modelPayload)}`
      );
    }
    t.diagnostic(
      `Largest estimated request including schemas + ${outputReserve} output reserve: ${Math.max(...requests.map((r) => estimateNoteTokens(JSON.stringify({ messages: r.messages, tools: r.tools })))) + outputReserve} / ${contextBudget}`
    );
    const toolMessages = requests.at(-1).messages.filter((message) => message.role === "tool");
    assert.equal(
      toolMessages.filter((message) => JSON.stringify(message).includes("transcript_only")).length,
      2
    );
  });
}

test("compaction leaves edit reads and unrelated action outcomes intact", async () => {
  const { compactTranscriptHistory } = await import("../../src/services/ai/transcriptHistory.ts");
  const result = (name, value) => ({
    role: "tool",
    content: [{ type: "tool-result", toolName: name, output: { type: "json", value } }],
  });
  const edit = result("get_note", {
    content: "Preserve every paragraph",
    summary: "Saved",
    transcript: "Preview",
  });
  const sent = result("email_send", { status: "sent", transcript_only: true });
  const pages = Array.from({ length: 6 }, (_, id) =>
    result("get_note", { id, transcript_only: true, transcript: "x".repeat(500) })
  );
  const messages = [edit, sent, ...pages];
  const compacted = compactTranscriptHistory(messages);
  assert.deepEqual(compacted.slice(0, 2), [edit, sent]);
  assert.equal(
    messages[2].content[0].output.value.transcript.length,
    500,
    "saved/UI messages are not mutated"
  );
  assert.equal(compacted.slice(2).filter((m) => m.content[0].output.value.transcript).length, 2);
});
