const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Generate AI Summary sends a whole transcript to a model that may reason for a
// minute or more before writing. Under the 30-second dictation deadline every
// such request was aborted and, counted as a network fault, retried three more
// times: four billed requests and no note (1.10.1).

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

// The provider tests above prove each client honours the scope. This one
// proves the scope arrives: the note store's overrides go through the real
// ReasoningService dispatch (managed-scope resolution, provider selection,
// retry) to the OpenAI client, and the request still outlives the dictation
// deadline and is sent once.
test("a note request through the real ReasoningService survives the dictation deadline and is sent once", async (t) => {
  installBrowserGlobals(t, {
    window: { electronAPI: { getOpenAIKey: async () => "test-key" } },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-note-deadline-test-" });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.1", policy: null });
  const { buildNoteFormattingOverrides } = await vite.ssrLoadModule(
    "/helpers/noteFormattingOverrides.js"
  );
  t.after(() => reasoningService.destroy());

  try {
    await runDeadlineScenario(t, () =>
      reasoningService.processText(
        "## Meeting Transcript\n" + "Alice: we agreed to ship on Friday.\n".repeat(200),
        "gpt-5.6-terra",
        null,
        {
          systemPrompt: "Summarize the meeting.",
          maxTokens: 4096,
          temperature: 0.3,
          ...buildNoteFormattingOverrides({ mode: "providers", provider: "openai" }, false),
        }
      )
    );
  } finally {
    // Hand real timers back before the harness tears the Vite server down.
    t.mock.timers.reset();
  }
});

// Enterprise requests run in the main process, whose handler applies its own
// 60-second default unless the renderer sends the deadline along.
test("enterprise note formatting sends the long deadline to the main process", async (t) => {
  const ipcConfigs = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        processEnterpriseReasoning: async (_text, _model, _agentName, config) => {
          ipcConfigs.push(config);
          return { success: true, text: "# Notes" };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-deadline-test-",
    mockModules: {
      "/models/ModelRegistry": `
        export const getOpenAiApiConfig = () => ({ supportsTemperature: true });
        export const isEnterpriseProvider = (provider) => provider === "bedrock";
      `,
      "/stores/settingsStore": "export const getSettings = () => ({ cleanupProvider: 'bedrock' });",
      "/services/ai/enterpriseSettings": "export const getEnterpriseCallSettings = () => ({});",
      "/utils/logger": "export default { logReasoning() {} };",
    },
  });
  const { enterpriseProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/enterprise.ts"
  );
  const call = (config) =>
    enterpriseProvider.call({
      text: "Alice: we agreed to ship on Friday.",
      model: "anthropic.claude-sonnet",
      agentName: null,
      config: { provider: "bedrock", ...config },
      ctx: CTX,
    });

  await call(NOTE_CONFIG);
  await call({});

  assert.equal(ipcConfigs[0].timeoutMs, 600_000);
  assert.equal(ipcConfigs[1].timeoutMs, 30_000, "dictation cleanup keeps the short deadline");
});

// Tinfoil goes through the OpenAI SDK, which reports an expired deadline as a
// connection error; without the mapping, withRetry would re-send it.
test("Tinfoil note formatting passes the long deadline to the SDK and does not retry its timeout", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tinfoil-deadline-test-",
    mockModules: {
      "/tinfoilClient": `
        export const getTinfoilChatClient = async () => ({
          chat: {
            completions: {
              create: async (_body, options) => {
                globalThis.__tinfoilCreateCalls.push(options);
                throw Object.assign(new Error("Request timed out."), {
                  name: "APIConnectionTimeoutError",
                });
              },
            },
          },
        });
      `,
    },
  });
  globalThis.__tinfoilCreateCalls = [];
  t.after(() => {
    delete globalThis.__tinfoilCreateCalls;
  });
  const { tinfoilProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/tinfoil.ts"
  );

  await assert.rejects(
    tinfoilProvider.call({
      text: "Alice: we agreed to ship on Friday.",
      model: "glm-5-3",
      agentName: null,
      config: NOTE_CONFIG,
      ctx: CTX,
    }),
    /Request timed out after 600s/
  );

  assert.equal(
    globalThis.__tinfoilCreateCalls.length,
    1,
    "an expired deadline must not be re-sent"
  );
  assert.equal(globalThis.__tinfoilCreateCalls[0].timeout, 600_000);
  assert.equal(globalThis.__tinfoilCreateCalls[0].maxRetries, 0);
});
