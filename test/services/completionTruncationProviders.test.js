const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const providerContext = {
  getApiKey: async () => "test-key",
  getSystemPrompt: () => "Clean the transcript",
  getCustomDictionary: () => [],
  getPreferredLanguage: () => "en",
  getUiLanguage: () => "en",
  callChatCompletionsApi: async () => {
    throw new Error("Unexpected chat completions delegation");
  },
  calculateMaxTokens: () => 4096,
};

function useJsonResponse(t, payload) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ input: String(input), init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return requests;
}

test("Gemini rejects partial cleanup text returned with MAX_TOKENS", async (t) => {
  const requests = useJsonResponse(t, {
    candidates: [
      {
        content: { parts: [{ text: "This cleanup ends halfway through" }] },
        finishReason: "MAX_TOKENS",
      },
    ],
    usageMetadata: {
      totalTokenCount: 2000,
      thoughtsTokenCount: 1800,
      candidatesTokenCount: 200,
    },
  });

  const { geminiProvider } = await import("../../src/services/ai/inferenceProviders/gemini.ts");

  await assert.rejects(
    geminiProvider.call({
      text: "Complete raw transcript",
      model: "gemini-3-flash-preview",
      agentName: null,
      config: { provider: "gemini", disableThinking: true },
      ctx: providerContext,
    }),
    { message: "Gemini hit the token limit and returned a truncated response" }
  );

  const requestBody = JSON.parse(requests[0].init.body);
  assert.equal(requestBody.generationConfig.maxOutputTokens, 8192);
  assert.deepEqual(requestBody.generationConfig.thinkingConfig, {
    thinkingLevel: "minimal",
    includeThoughts: false,
  });
});

test("OpenAI Responses rejects partial cleanup text at max_output_tokens", async (t) => {
  useJsonResponse(t, {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "This cleanup also ends halfway" }],
      },
    ],
    usage: { total_tokens: 4096 },
  });

  const { openaiProvider } = await import("../../src/services/ai/inferenceProviders/openai.ts");

  await assert.rejects(
    openaiProvider.call({
      text: "Complete raw transcript",
      model: "responses-model",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://cleanup.example.com/v1/responses",
        customApiKey: "test-key",
      },
      ctx: providerContext,
    }),
    { message: "Custom endpoint hit the token limit and returned a truncated response" }
  );
});

test("OpenAI Chat Completions rejects partial cleanup text with finish_reason length", async (t) => {
  useJsonResponse(t, {
    choices: [
      {
        finish_reason: "length",
        message: { content: "This cleanup stops before the transcript does" },
      },
    ],
    usage: { total_tokens: 4096 },
  });

  const { openaiProvider } = await import("../../src/services/ai/inferenceProviders/openai.ts");

  await assert.rejects(
    openaiProvider.call({
      text: "Complete raw transcript",
      model: "chat-model",
      agentName: null,
      config: {
        provider: "custom",
        baseUrl: "https://cleanup-chat.example.com/v1/chat/completions",
        customApiKey: "test-key",
      },
      ctx: providerContext,
    }),
    { message: "Custom endpoint hit the token limit and returned a truncated response" }
  );
});

test("Tinfoil rejects partial cleanup text with finish_reason length", async (t) => {
  installBrowserGlobals(t);
  globalThis.__truncatedTinfoilClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              finish_reason: "length",
              message: { content: "This private cleanup is incomplete" },
            },
          ],
          usage: { total_tokens: 4096 },
        }),
      },
    },
  };
  t.after(() => {
    delete globalThis.__truncatedTinfoilClient;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tinfoil-truncation-test-",
    mockModules: {
      "/tinfoilClient": `
        export const getTinfoilChatClient = async () => globalThis.__truncatedTinfoilClient;
      `,
    },
  });
  const { tinfoilProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/tinfoil.ts"
  );

  await assert.rejects(
    tinfoilProvider.call({
      text: "Complete raw transcript",
      model: "private-model",
      agentName: null,
      config: { provider: "tinfoil" },
      ctx: providerContext,
    }),
    { message: "Tinfoil hit the token limit and returned a truncated response" }
  );
});

test("generic Chat Completions rejects partial cleanup text before returning it", async (t) => {
  installBrowserGlobals(t);
  useJsonResponse(t, {
    choices: [
      {
        finish_reason: "length",
        message: { content: "This generic cleanup is incomplete" },
      },
    ],
    usage: { total_tokens: 4096 },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-generic-truncation-test-",
  });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  await assert.rejects(
    reasoningService.callChatCompletionsApi(
      "https://cleanup.example.com/v1/chat/completions",
      "test-key",
      "chat-model",
      "Complete raw transcript",
      null,
      { provider: "groq" },
      "Groq"
    ),
    { message: "Groq hit the token limit and returned a truncated response" }
  );
});
