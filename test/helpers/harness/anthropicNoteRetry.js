const { createRendererServer, installBrowserGlobals } = require("../../lib/rendererTestHarness");

// Keep the store's real retry/save path and the real Anthropic renderer adapter.
// Only select that adapter at the routing seam, and supply the IPC transport.
async function runAnthropicNoteRetry(t, invoke) {
  const updates = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        processAnthropicReasoning: invoke,
        updateNote: async (noteId, payload) => {
          updates.push({ noteId, payload });
          return { success: true };
        },
        getNote: async () => ({ id: 901, title: "Offline note", enhanced_content: null }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "anthropic-note-retry-",
    mockModules: {
      "/services/ReasoningService": `
        import { anthropicProvider } from "/services/ai/inferenceProviders/anthropic";
        export default { processText: (text, model, agentName, config) =>
          anthropicProvider.call({text, model, agentName, config,
            ctx: {getSystemPrompt: () => "Summarize"}}) };
      `,
      "/utils/generateTitle": `export const generateNoteTitle = async () => undefined;`,
    },
  });
  const { setResolvedLLMConfig } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  setResolvedLLMConfig("noteFormatting", {
    mode: "providers",
    provider: "anthropic",
    model: "claude-haiku-5-5",
  });
  const store = await vite.ssrLoadModule("/stores/actionProcessingStore.ts");
  store.runBackgroundAction(
    901,
    "## Meeting Transcript\nAlice: send the proposal on Friday.",
    "hash",
    { id: 1, name: "Generate Notes", prompt: "Summarize the meeting." },
    { modelId: "claude-haiku-5-5", isCloudMode: false, isMeetingNote: true },
    { noModel: "no model", noEndpoint: "no endpoint", actionFailed: "failed" }
  );
  for (let n = 0; n < 200; n++) {
    const errors = store.consumeErrorEvents();
    if (updates.length || errors.length) return { updates, errors };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Anthropic notes run did not settle");
}
module.exports = { runAnthropicNoteRetry };
