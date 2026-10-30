const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Earlier tool calls replayed as tool messages, as each hosted provider's
// request carries them: every call paired with its result by an id the
// provider takes, and nothing an OpenAI zero-retention org would have to
// look up (no item ids or references).

const EARLIER_TURN = [
  { id: "u1", role: "user", content: "Tell Chad the build is green", isStreaming: false },
  {
    id: "a1",
    role: "assistant",
    content: "Posted it to Chad.",
    isStreaming: false,
    toolCalls: [
      {
        id: "call:slack/1",
        name: "slack_send_message",
        arguments: JSON.stringify({ destination: "Chad", text: "The build is green" }),
        status: "completed",
        metadata: { status: "sent", url: "https://acme.slack.com/archives/D1/p2" },
      },
    ],
  },
  { id: "u2", role: "user", content: "Did that go out?", isStreaming: false },
];
const CALL_ID = "callslack1";
const RESULT = '{"status":"sent","link":"https://acme.slack.com/archives/D1/p2"}';

async function requestBody(t, provider, model) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getOpenAIKey: async () => "test-key",
        getAnthropicKey: async () => "test-key",
        getGeminiKey: async () => "test-key",
        getGroqKey: async () => "test-key",
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-tool-history-requests-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { ToolRegistry } = await vite.ssrLoadModule("/services/tools/ToolRegistry.ts");
  const { toHistoryMessages } = await vite.ssrLoadModule("/components/chat/historyMessages.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());

  const registry = new ToolRegistry();
  registry.register({
    name: "slack_send_message",
    description: "Post to Slack",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    readOnly: false,
    execute: async () => ({ success: true, data: null, displayText: "" }),
  });

  const bodies = [];
  const originalFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = originalFetch));
  // The request is all this checks; refusing it ends the stream at once.
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ error: { message: "stop here" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const history = toHistoryMessages(EARLIER_TURN, { toolHistory: "parts" });
  const stream = reasoningService.processTextStreamingAI(
    history,
    model,
    provider,
    { systemPrompt: "Answer the user." },
    registry.toAISDKFormat()
  );
  await assert.rejects(async () => {
    for await (const _chunk of stream);
  });
  assert.equal(bodies.length, 1);
  return bodies[0];
}

test("OpenAI Responses gets a call and its output paired by call id, with no stored items", async (t) => {
  const body = await requestBody(t, "openai", "gpt-5-mini");
  const call = body.input.find((item) => item.type === "function_call");
  const output = body.input.find((item) => item.type === "function_call_output");
  assert.deepEqual(call, {
    type: "function_call",
    call_id: CALL_ID,
    name: "slack_send_message",
    arguments: '{"destination":"Chad"}',
  });
  assert.deepEqual(output, { type: "function_call_output", call_id: CALL_ID, output: RESULT });
  assert.equal(
    body.input.some((item) => item.type === "item_reference"),
    false
  );
  assert.equal(body.store, false);
});

test("Anthropic gets a tool_use and its tool_result in the next message", async (t) => {
  const body = await requestBody(t, "anthropic", "claude-sonnet-5");
  const roles = body.messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant", "user"]);
  const [use] = body.messages[1].content;
  assert.deepEqual(
    { type: use.type, id: use.id, name: use.name, input: use.input },
    { type: "tool_use", id: CALL_ID, name: "slack_send_message", input: { destination: "Chad" } }
  );
  const [result] = body.messages[2].content;
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, CALL_ID);
  assert.match(JSON.stringify(result.content), /\\"status\\":\\"sent\\"/);
});

test("Gemini gets a function call and its response", async (t) => {
  const body = await requestBody(t, "gemini", "gemini-3.5-flash");
  const parts = body.contents.flatMap((content) => content.parts);
  const call = parts.find((part) => part.functionCall);
  const response = parts.find((part) => part.functionResponse);
  assert.deepEqual(call.functionCall, {
    id: CALL_ID,
    name: "slack_send_message",
    args: { destination: "Chad" },
  });
  assert.equal(response.functionResponse.id, CALL_ID);
  assert.equal(response.functionResponse.name, "slack_send_message");
  assert.match(JSON.stringify(response.functionResponse.response), /\\"status\\":\\"sent\\"/);
});

test("Groq gets an assistant tool call and a tool message with the same id", async (t) => {
  const body = await requestBody(t, "groq", "openai/gpt-oss-120b");
  const assistant = body.messages.find((message) => message.tool_calls);
  const tool = body.messages.find((message) => message.role === "tool");
  assert.deepEqual(assistant.tool_calls, [
    {
      id: CALL_ID,
      type: "function",
      function: { name: "slack_send_message", arguments: '{"destination":"Chad"}' },
    },
  ]);
  assert.deepEqual(
    { id: tool.tool_call_id, content: tool.content },
    { id: CALL_ID, content: RESULT }
  );
});
