const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/inferenceProviders/openai.ts");

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

// openai.ts remembers the endpoint it settled on per base URL at module scope, so each
// test needs its own base to reach the endpoint it means to exercise. Callers can pass
// `requested` to assert which endpoints the provider actually called.
async function callOpenAI(t, { base, responses, chat, requested = [] }, config = {}) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || "GET";
    requested.push(`${method} ${url}`);
    if (method === "GET") return json({}, 404); // model discovery
    if (url.endsWith("/responses")) {
      return responses ? json(responses) : json({ error: { message: "no responses api" } }, 404);
    }
    if (url.endsWith("/chat/completions")) return json(chat);
    throw new Error(`Unexpected request: ${url}`);
  };

  const { openaiProvider } = await load();
  return openaiProvider.call({
    text: "raw transcript",
    model: "cleanup-model",
    agentName: null,
    config: { provider: "custom", baseUrl: base, customApiKey: "test-key", ...config },
    ctx: providerContext,
  });
}

const incompleteResponses = {
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }],
};
const lengthCappedChat = {
  choices: [{ message: { content: "Partial" }, finish_reason: "length" }],
};

test("an incomplete Responses reply rejects with the localizable truncation error", async (t) => {
  await assert.rejects(
    callOpenAI(
      t,
      { base: "https://incomplete.example/v1", responses: incompleteResponses },
      { requireCompleteOutput: true }
    ),
    (error) => {
      assert.match(error.message, /Model output was truncated/);
      // The cleanup toast renders this key rather than the English message.
      assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.cleanupTruncated");
      return true;
    }
  );
});

test("a length-capped chat reply rejects when complete output is required", async (t) => {
  const requested = [];

  await assert.rejects(
    callOpenAI(
      t,
      { base: "https://chat-capped.example/v1", chat: lengthCappedChat, requested },
      { requireCompleteOutput: true }
    ),
    /Model output was truncated/
  );

  // Without the 404 above, the provider would have stopped at /responses and this case
  // would never have reached the chat path it is named for.
  assert.deepEqual(requested, [
    "GET https://chat-capped.example/v1/models",
    "POST https://chat-capped.example/v1/responses",
    "POST https://chat-capped.example/v1/chat/completions",
  ]);
});

test("a truncated reply still resolves when the caller did not require complete output", async (t) => {
  const text = await callOpenAI(t, {
    base: "https://truncated-allowed.example/v1",
    responses: incompleteResponses,
  });

  assert.equal(text, "Partial");
});

test("an empty reply rejects with the localizable empty-reply error", async (t) => {
  await assert.rejects(
    callOpenAI(
      t,
      { base: "https://empty-required.example/v1", responses: { output: [] } },
      { requireCompleteOutput: true }
    ),
    (error) => {
      assert.match(error.message, /Model returned an empty response/);
      assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.cleanupEmptyReply");
      return true;
    }
  );
});

test("an empty reply falls back to the input when complete output is not required", async (t) => {
  const text = await callOpenAI(t, {
    base: "https://empty-allowed.example/v1",
    responses: { output: [] },
  });

  assert.equal(text, "raw transcript");
});
