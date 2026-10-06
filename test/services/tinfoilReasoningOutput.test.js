const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Tinfoil serves open-weight reasoning models whose thinking counts against
// max_tokens. When the cap is hit before any text, the provider used to hand
// the caller its own input back as if the model had produced it.

async function loadProvider(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tinfoil-output-test-",
    mockModules: {
      "/tinfoilClient": `
        export const getTinfoilChatClient = async () => ({
          chat: { completions: { create: async () => globalThis.__tinfoilResponse } },
        });
      `,
    },
  });
  t.after(() => {
    delete globalThis.__tinfoilResponse;
  });
  const { tinfoilProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/tinfoil.ts"
  );
  return tinfoilProvider;
}

const ctx = {
  getApiKey: async () => "test-key",
  getSystemPrompt: () => "Clean the transcript",
  calculateMaxTokens: () => 4096,
};

test("a Tinfoil result cut off before any text is an error, not the input echoed back", async (t) => {
  const tinfoilProvider = await loadProvider(t);
  globalThis.__tinfoilResponse = {
    choices: [{ message: { content: "" }, finish_reason: "length" }],
  };

  await assert.rejects(
    tinfoilProvider.call({
      text: "## Meeting Transcript\nYou: ship on Friday.",
      model: "gpt-oss-120b",
      agentName: null,
      config: { systemPrompt: "Summarize", maxTokens: 4096 },
      ctx,
    }),
    /ran out of output tokens/
  );
});

test("an empty but complete Tinfoil response on a task with its own prompt is an error", async (t) => {
  const tinfoilProvider = await loadProvider(t);
  globalThis.__tinfoilResponse = {
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  };

  await assert.rejects(
    tinfoilProvider.call({
      text: "## Meeting Transcript\nYou: ship on Friday.",
      model: "gpt-oss-120b",
      agentName: null,
      config: { systemPrompt: "Summarize", maxTokens: 4096 },
      ctx,
    }),
    /empty response/
  );
});

test("an empty but complete Tinfoil response still falls back to the input for cleanup", async (t) => {
  const tinfoilProvider = await loadProvider(t);
  globalThis.__tinfoilResponse = {
    choices: [{ message: { content: "" }, finish_reason: "stop" }],
  };

  const result = await tinfoilProvider.call({
    text: "raw dictation",
    model: "gpt-oss-120b",
    agentName: null,
    config: {},
    ctx,
  });

  assert.equal(result, "raw dictation");
});
