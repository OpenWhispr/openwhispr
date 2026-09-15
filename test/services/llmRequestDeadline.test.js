const test = require("node:test");
const assert = require("node:assert/strict");

// Generate AI Summary on a bring-your-own-key provider sends a whole transcript
// to a model that may reason for a minute or more before writing. The 30-second
// dictation deadline aborted every such request, and because a timeout counted
// as a network fault, the request was retried three more times: about 1.5
// minutes of spinner, four billed requests, and no note.

const NOTE_CONFIG = {
  systemPrompt: "Summarize the meeting.",
  inferenceScope: "noteFormatting",
  maxTokens: 4096,
  temperature: 0.3,
};

const CTX = {
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

// A fetch whose POSTs never answer on their own but honor the abort signal,
// the way a real request does while the model is still generating.
function installHangingFetch(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const posts = [];
  globalThis.fetch = (input, init = {}) => {
    const method = init.method || "GET";
    if (method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: "not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    posts.push(String(input));
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    });
  };
  return posts;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function runDeadlineScenario(t, startRequest) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const posts = installHangingFetch(t);

  let outcome = null;
  const request = startRequest().then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    }
  );
  await settle();
  assert.equal(posts.length, 1, "the request should be in flight");

  // The dictation deadline must not fire on a note.
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(outcome, null, "a note request must survive the 30-second dictation deadline");

  t.mock.timers.tick(600_000);
  await settle();
  // A retry would be waiting on its backoff timer here; drain it so the second
  // POST shows up in `posts` instead of leaving `request` pending.
  t.mock.timers.tick(10_000);
  await settle();

  assert.equal(posts.length, 1, "a timed-out request must not be retried");
  assert.ok(outcome?.error, "the request should end in an error once the long deadline expires");
  assert.match(outcome.error.message, /Request timed out after 600s/);
  await request;
}

test("OpenAI note formatting waits ten minutes and does not retry a timed-out request", async (t) => {
  const { openaiProvider } = await import("../../src/services/ai/inferenceProviders/openai.ts");
  await runDeadlineScenario(t, () =>
    openaiProvider.call({
      text: "Alice: we agreed to ship on Friday.\n".repeat(200),
      model: "gpt-5.6-terra",
      agentName: null,
      config: { provider: "openai", ...NOTE_CONFIG },
      ctx: CTX,
    })
  );
});

test("Gemini note formatting waits ten minutes and does not retry a timed-out request", async (t) => {
  const { geminiProvider } = await import("../../src/services/ai/inferenceProviders/gemini.ts");
  await runDeadlineScenario(t, () =>
    geminiProvider.call({
      text: "Alice: we agreed to ship on Friday.\n".repeat(200),
      model: "gemini-3.5-flash",
      agentName: null,
      config: NOTE_CONFIG,
      ctx: CTX,
    })
  );
});

test("dictation cleanup keeps its 30-second deadline", async (t) => {
  const { openaiProvider } = await import("../../src/services/ai/inferenceProviders/openai.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const posts = installHangingFetch(t);

  let outcome = null;
  const request = openaiProvider
    .call({
      text: "clean this up",
      model: "gpt-4.1-mini",
      agentName: null,
      config: { provider: "openai" },
      ctx: CTX,
    })
    .then(
      (value) => {
        outcome = { value };
      },
      (error) => {
        outcome = { error };
      }
    );
  await settle();
  assert.equal(posts.length, 1);

  t.mock.timers.tick(30_000);
  await settle();
  await request;

  assert.match(outcome?.error?.message ?? "", /Request timed out after 30s/);
});
