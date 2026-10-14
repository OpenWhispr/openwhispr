const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A self-hosted reasoning model (Ollama, vLLM, llama.cpp) can spend the whole
// output cap inside <think>, so nothing is left once the block is stripped.
// That cut-off carries the code note formatting retries with more room (#2008).
test("a self-hosted reply that only thought until the cap carries the cut-off code", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-lan-reasoning-test-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { content: "<think>Let me read the transcript" }, finish_reason: "length" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  await assert.rejects(
    reasoningService.processText("## Meeting Transcript\nYou: ship on Friday.", "glm-5.3", null, {
      lanUrl: "http://127.0.0.1:11434/v1",
      systemPrompt: "Summarize",
      maxTokens: 4096,
    }),
    { message: /ran out of output tokens/, code: "OUTPUT_LIMIT_BEFORE_ANSWER" }
  );
});
