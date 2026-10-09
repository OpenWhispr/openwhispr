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

test("compaction leaves edit reads, unrelated action outcomes and the latest step intact", async () => {
  const { compactTranscriptHistory } = await import("../../src/services/ai/transcriptHistory.ts");
  const step = (...results) => [
    { role: "assistant", content: [{ type: "tool-call" }] },
    {
      role: "tool",
      content: results.map(([name, value]) => ({
        type: "tool-result",
        toolName: name,
        output: { type: "json", value },
      })),
    },
  ];
  const page = (id) => [
    "get_note",
    { id, transcript_only: true, transcript: "x".repeat(500), transcript_start: id * 500 },
  ];
  const edit = ["get_note", { content: "Preserve every paragraph", summary: "Saved" }];
  const sent = ["email_send", { status: "sent", transcript_only: true }];
  const passages = (messages) =>
    messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((part) => part.output.value.transcript)
      .map((part) => part.output.value.id);

  const sequential = [...step(edit, sent), ...[0, 1, 2, 3].flatMap((id) => step(page(id)))];
  const compacted = compactTranscriptHistory(sequential);
  assert.deepEqual(compacted.slice(0, 2), sequential.slice(0, 2));
  assert.equal(
    sequential[3].content[0].output.value.transcript.length,
    500,
    "saved/UI messages are not mutated"
  );
  assert.deepEqual(passages(compacted), [2, 3]);
  assert.deepEqual(compacted[3].content[0].output.value, {
    id: 0,
    transcript_omitted: true,
    transcript_start: 0,
    transcript_end: undefined,
  });

  // Parallel calls in the latest step all reach the model, however many there are.
  const parallel = [...step(page(0)), ...step(page(1), page(2), page(3), page(4))];
  assert.deepEqual(passages(compactTranscriptHistory(parallel)), [1, 2, 3, 4]);
  // The Cloud loop gives each call its own pair, so it names where the step starts.
  const pairs = [...step(page(0)), ...step(page(1)), ...step(page(2)), ...step(page(3))];
  assert.deepEqual(passages(compactTranscriptHistory(pairs, 4)), [2, 3]);
  assert.deepEqual(passages(compactTranscriptHistory(pairs, 2)), [1, 2, 3]);
});

for (const provider of ["local SDK", "cloud"]) {
  test(`${provider}: parallel passages from one step all reach the next request`, async (t) => {
    const parallel = [0, 500, 1000].map((offset) => ({
      id: `page-${offset}`,
      name: "get_note",
      arguments: JSON.stringify({ id: 7, transcript_offset: offset }),
    }));
    const requests = [];
    let onChunk;
    let onEnd;
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          getNote: async () => ({ id: 7, title: "Launch", transcript: TRANSCRIPT }),
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
          startAgentStream: (requestId, messages) => {
            const first = requests.length === 0;
            requests.push(structuredClone(messages));
            queueMicrotask(() => {
              for (const chunk of first
                ? parallel.map((call) => ({ type: "tool_call", ...call }))
                : [{ type: "content", text: "done" }])
                onChunk({ requestId, chunk });
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
    const registry = new ToolRegistry();
    registry.register(getNoteTool);
    const originalFetch = global.fetch;
    t.after(() => {
      global.fetch = originalFetch;
    });
    global.fetch = async (_url, init) => {
      const first = requests.length === 0;
      requests.push(JSON.parse(init.body).messages);
      const chunk = (delta, finish_reason = null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "qwen3-4b-q4_k_m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const delta = first
        ? {
            tool_calls: parallel.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : { content: "done" };
      return new Response(
        chunk(delta) + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    const messages = [{ role: "user", content: "Read the start of the meeting." }];
    const stream =
      provider === "cloud"
        ? reasoning.processTextStreamingCloud(messages, {
            systemPrompt: "",
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
            { systemPrompt: "" },
            registry.toAISDKFormat()
          );
    for await (const _chunk of stream);
    assert.equal(requests.length, 2);
    const followUp = JSON.stringify(requests[1]);
    assert.doesNotMatch(followUp, /transcript_omitted/);
    for (const offset of [0, 500, 1000])
      assert.match(followUp, new RegExp(`transcript_start\\\\?":${offset},`));
  });
}
