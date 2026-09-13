const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Providers that bridge through IPC (local, enterprise, OpenWhispr Cloud) relay
// whatever text the main process hands back. A blank result must fail in
// processText rather than reach a caller that saves or pastes it.

test("processText rejects a provider result with no text", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        processLocalReasoning: async () => ({ success: true, text: "   " }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-empty-result-test-",
  });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  await assert.rejects(
    reasoningService.processText("## Meeting Transcript\nYou: ship on Friday.", "qwen3-4b", null, {
      provider: "local",
      systemPrompt: "Summarize",
    }),
    /empty response/
  );
});
