const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function loadReasoningService(t, cachePrefix) {
  installBrowserGlobals(t, {});
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());
  return reasoningService;
}

/** Captures the headers of the streaming POST and answers with a one-chunk SSE body. */
function installStreamRecorder(t, sent) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init = {}) => {
    sent.push({ endpoint: String(input), headers: init.headers || {} });
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`;
    return new Response(`${event}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

async function streamAgainst(reasoningService, lanUrl) {
  const stream = reasoningService.processTextStreaming(
    [{ role: "user", content: "hello" }],
    "kimi-k2.5",
    "lan",
    { systemPrompt: "Answer the user.", lanUrl }
  );
  let output = "";
  for await (const chunk of stream) output += chunk;
  return output;
}

test("self-hosted streaming sends a session id to OpenCode Go", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-opencode-stream-test-");
  const sent = [];
  installStreamRecorder(t, sent);

  assert.equal(await streamAgainst(reasoningService, "https://opencode.ai/zen/go/v1"), "ok");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.match(sent[0].headers["x-opencode-session"], UUID_RE);
});

test("self-hosted streaming sends no session id to other endpoints", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-opencode-stream-other-test-");
  const sent = [];
  installStreamRecorder(t, sent);

  assert.equal(await streamAgainst(reasoningService, "http://127.0.0.1:11434/v1"), "ok");

  assert.equal(sent.length, 1);
  assert.equal("x-opencode-session" in sent[0].headers, false);
});

/** Captures the headers of the non-streaming POST and answers with a chat completion. */
function installCompletionRecorder(t, sent) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input, init = {}) => {
    sent.push({ endpoint: String(input), headers: init.headers || {} });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Cleaned" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
}

test("self-hosted cleanup sends a session id to OpenCode Go", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-opencode-cleanup-test-");
  const sent = [];
  installCompletionRecorder(t, sent);

  const result = await reasoningService.processText("clean this up", "kimi-k2.5", null, {
    lanUrl: "https://opencode.ai/zen/go/v1",
  });

  assert.equal(result, "Cleaned");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.match(sent[0].headers["x-opencode-session"], UUID_RE);
});
