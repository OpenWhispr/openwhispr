const test = require("node:test");
const assert = require("node:assert/strict");

const loadProviders = () => import("../../src/services/ai/providers.ts");

/** Drains a local chat stream and returns the JSON body the transport actually sent. */
async function captureLocalChatBody(t, opts) {
  const { getAIModel } = await loadProviders();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let body = null;
  globalThis.fetch = async (_input, init = {}) => {
    body = JSON.parse(init.body);
    const chunk = (delta, finishReason = null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-local-thinking-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "qwen3.5-9b",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    return new Response(`${chunk({ content: "ok" })}${chunk({}, "stop")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const model = await getAIModel("local", "qwen3.5-9b", "", "http://127.0.0.1:8221/v1", opts);
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  for await (const _part of stream) {
    // Drain so the request completes.
  }
  return body;
}

test("a local chat with thinking disabled asks llama-server's template to skip thinking", async (t) => {
  const body = await captureLocalChatBody(t, { disableThinking: true });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.model, "qwen3.5-9b");
});

test("a local chat with thinking allowed sends no template override", async (t) => {
  const body = await captureLocalChatBody(t, { disableThinking: false });
  assert.equal("chat_template_kwargs" in body, false);
  const defaulted = await captureLocalChatBody(t, undefined);
  assert.equal("chat_template_kwargs" in defaulted, false);
});
