const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// An own OpenAI key in a Zero Data Retention organization: OpenAI keeps nothing
// between requests, so the step after a tool call must resend the reasoning
// item itself (encrypted) instead of pointing at a stored copy by id.

const ZDR_MISSING_ITEM =
  "Item with id 'rs_test' not found. Items are not persisted for Zero Data Retention " +
  "organizations. Remove this item from your input and try again.";

function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const created = (id) => ({
  type: "response.created",
  response: { id, created_at: 1, model: "gpt-5-mini" },
});
const completed = {
  type: "response.completed",
  response: { usage: { input_tokens: 1, output_tokens: 1 } },
};

// Conservative legacy fixture: encrypted reasoning only comes back when requested.
function toolCallResponse(body) {
  const wantsEncrypted = (body.include || []).includes("reasoning.encrypted_content");
  const reasoning = {
    type: "reasoning",
    id: "rs_test",
    ...(wantsEncrypted ? { encrypted_content: "encrypted-reasoning" } : {}),
  };
  const call = {
    type: "function_call",
    id: "fc_test",
    call_id: "call_test",
    name: "search_notes",
    arguments: "{}",
  };
  return sse([
    created("resp_1"),
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: call },
    { type: "response.output_item.done", output_index: 1, item: { ...call, status: "completed" } },
    completed,
  ]);
}

function answerResponse() {
  const message = { type: "message", id: "msg_test" };
  return sse([
    created("resp_2"),
    { type: "response.output_item.added", output_index: 0, item: message },
    { type: "response.output_text.delta", item_id: "msg_test", delta: "We chose the pilot." },
    { type: "response.output_item.done", output_index: 0, item: message },
    completed,
  ]);
}

test("OpenAI reasoning model: the step after a tool call works without stored items", async (t) => {
  installBrowserGlobals(t, {
    window: { electronAPI: { getOpenAIKey: async () => "test-key" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-openai-zdr-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  t.after(() => reasoningService.destroy());

  const registry = new ToolRegistry();
  registry.register({
    name: "search_notes",
    description: "Search notes",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    execute: async () => ({ success: true, data: [], displayText: "No notes" }),
  });

  const bodies = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) return toolCallResponse(body);
    if (body.input.some((item) => item.type === "item_reference")) {
      return new Response(
        JSON.stringify({
          error: { message: ZDR_MISSING_ITEM, type: "invalid_request_error", code: null },
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }
    return answerResponse();
  };

  const stream = reasoningService.processTextStreamingAI(
    [{ role: "user", content: "What did we decide in the Acme kickoff note?" }],
    "gpt-5-mini",
    "openai",
    { systemPrompt: "Answer the user." },
    registry.toAISDKFormat()
  );
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);

  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.equal(body.store, false);
  const resent = bodies[1].input.find((item) => item.type === "reasoning");
  assert.equal(resent?.encrypted_content, "encrypted-reasoning");
  const answer = chunks
    .filter((chunk) => chunk.type === "content")
    .map((chunk) => chunk.text)
    .join("");
  assert.equal(answer, "We chose the pilot.");
});
