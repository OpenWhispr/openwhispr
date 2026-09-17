const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/gemini.ts");

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

function createGeminiResponse(parts, finishReason = "STOP") {
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 4,
      totalTokenCount: 16,
    },
  };
}

// Pass `requests` to read what the provider actually sent, not what the config asked for.
async function callGemini(
  t,
  response,
  config = {},
  { model = "gemini-2.5-flash", requests = [] } = {}
) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init = {}) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { geminiProvider } = await load();
  return geminiProvider.call({
    text: "raw transcript",
    model,
    agentName: null,
    config: { systemPrompt: "Clean the transcript", ...config },
    ctx: providerContext,
  });
}

test("Gemini provider returns all visible text without leaking thought or non-text parts", async (t) => {
  const response = createGeminiResponse([
    { thought: true, text: "Private reasoning" },
    { functionCall: { name: "ignored", args: {} } },
    { text: "First paragraph.\n\n" },
    { inlineData: { mimeType: "image/png", data: "ignored" } },
    { text: "Second paragraph." },
  ]);

  assert.equal(await callGemini(t, response), "First paragraph.\n\nSecond paragraph.");
});

test("Gemini provider accepts text after a leading non-text part", async (t) => {
  const response = createGeminiResponse([
    { functionCall: { name: "ignored", args: {} } },
    { text: "Visible answer" },
  ]);

  assert.equal(await callGemini(t, response), "Visible answer");
});

test("Gemini provider rejects whitespace-only text as an empty response", async (t) => {
  const response = createGeminiResponse([{ text: "  \n " }]);

  await assert.rejects(callGemini(t, response), /Gemini returned empty response/);
});

test("Gemini provider preserves complete-output truncation errors before extraction", async (t) => {
  const response = createGeminiResponse([{ text: "Partial answer" }], "MAX_TOKENS");

  await assert.rejects(
    callGemini(t, response, { requireCompleteOutput: true }),
    /Model output was truncated/
  );
});

// Gemini bills thinking against maxOutputTokens, so a cap sized for the cleaned text
// was spent on thinking and the reply arrived cut off or empty (#2091). The model's
// own limit bounds the reply instead.
test("Gemini requests carry no output cap, so thinking cannot starve the reply", async (t) => {
  const requests = [];

  await callGemini(
    t,
    createGeminiResponse([{ text: "Cleaned." }]),
    {},
    { model: "gemini-3-flash-preview", requests }
  );

  assert.equal(requests[0].generationConfig.maxOutputTokens, undefined);
});

test("a caller's pinned budget does not reintroduce a cap", async (t) => {
  // Note formatting pins maxTokens for the local path; letting it cap Gemini halved
  // long summaries (#2142).
  const requests = [];

  await callGemini(
    t,
    createGeminiResponse([{ text: "Cleaned." }]),
    { maxTokens: 1000 },
    { requests }
  );

  assert.equal(requests[0].generationConfig.maxOutputTokens, undefined);
});
