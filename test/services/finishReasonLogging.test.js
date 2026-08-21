const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A cleanup that stops at its token cap still returns text, so the pipeline
// keeps pasting it. These tests pin the part that used to be invisible: the
// success log now carries the raw finish reason and a normalized `truncated`
// flag, while the pasted text is byte-for-byte what it was before.
const LAN_URL = "http://127.0.0.1:8585/v1";
const LOG_KEY = "__openwhisprReasoningLogEntries";

function chatCompletion(content, finishReason) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { total_tokens: 42 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

test("the non-streaming success log carries the finish reason", async (t) => {
  installBrowserGlobals(t);
  globalThis[LOG_KEY] = [];
  t.after(() => {
    delete globalThis[LOG_KEY];
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-finish-reason-test-",
    mockModules: {
      "/utils/logger": `
        const noop = () => {};
        export default {
          trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
          refreshLogLevel: noop,
          logReasoning: (stage, details) => {
            globalThis["${LOG_KEY}"].push({ stage, details });
          },
        };
      `,
    },
  });

  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");

  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.1", policy: null });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const respondWith = (content, finishReason) => {
    globalThis[LOG_KEY] = [];
    globalThis.fetch = async () => chatCompletion(content, finishReason);
  };
  const successLog = () =>
    globalThis[LOG_KEY].find((entry) => entry.stage === "LAN_RESPONSE")?.details;

  await t.test("a cleanup stopped at the token cap is logged as truncated", async () => {
    respondWith("Cleaned text that stops mid-", "length");

    const result = await reasoningService.processText("raw transcript", "gemma", null, {
      provider: "lan",
      lanUrl: LAN_URL,
    });

    // Behavior is unchanged: the user still gets the (shortened) cleanup.
    assert.equal(result, "Cleaned text that stops mid-");
    assert.deepEqual(
      { finishReason: successLog()?.finishReason, truncated: successLog()?.truncated },
      { finishReason: "length", truncated: true }
    );
  });

  await t.test("a complete cleanup logs the same fields, not truncated", async () => {
    respondWith("Cleaned text.", "stop");

    const result = await reasoningService.processText("raw transcript", "gemma", null, {
      provider: "lan",
      lanUrl: LAN_URL,
    });

    assert.equal(result, "Cleaned text.");
    assert.deepEqual(
      { finishReason: successLog()?.finishReason, truncated: successLog()?.truncated },
      { finishReason: "stop", truncated: false }
    );
  });

  await t.test("the selection-edit guard still rejects truncated output", async () => {
    respondWith("Partial edit", "length");

    await assert.rejects(
      reasoningService.processText("edit this", "gemma", null, {
        provider: "lan",
        lanUrl: LAN_URL,
        systemPrompt: "Edit the selection.",
        requireCompleteOutput: true,
      }),
      { message: "Model output was truncated before the selection edit completed" }
    );
  });

  // Enterprise runs in the main process, so the finish reason arrives already
  // normalized over IPC; the renderer's job is only to log the pair it is given.
  await t.test("an enterprise reply logs the finish reason it was handed", async () => {
    globalThis[LOG_KEY] = [];
    globalThis.window.electronAPI.processEnterpriseReasoning = async () => ({
      success: true,
      text: "Cleaned text that stops mid-",
      finishReason: "length",
      truncated: true,
    });

    const result = await reasoningService.processText("raw transcript", "claude-sonnet-4", null, {
      provider: "bedrock",
    });

    assert.equal(result, "Cleaned text that stops mid-");
    const details = globalThis[LOG_KEY].find(
      (entry) => entry.stage === "ENTERPRISE_SUCCESS"
    )?.details;
    assert.deepEqual(
      { finishReason: details?.finishReason, truncated: details?.truncated },
      { finishReason: "length", truncated: true }
    );
  });
});
