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
          chat: {
            completions: {
              create: async (body, options) =>
                globalThis.__tinfoilCreate?.(options) ?? globalThis.__tinfoilResponse,
            },
          },
        });
      `,
    },
  });
  t.after(() => {
    delete globalThis.__tinfoilResponse;
    delete globalThis.__tinfoilCreate;
  });
  const { tinfoilProvider } = await vite.ssrLoadModule(
    "/services/ai/inferenceProviders/tinfoil.ts"
  );
  return { tinfoilProvider, vite };
}

const ctx = {
  getApiKey: async () => "test-key",
  getSystemPrompt: () => "Clean the transcript",
  calculateMaxTokens: () => 4096,
};

test("a Tinfoil result cut off before any text is an error, not the input echoed back", async (t) => {
  const { tinfoilProvider } = await loadProvider(t);
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
    { message: /ran out of output tokens/, code: "OUTPUT_LIMIT_BEFORE_ANSWER" }
  );
});

test("an empty but complete Tinfoil response on a task with its own prompt is an error", async (t) => {
  const { tinfoilProvider } = await loadProvider(t);
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
  const { tinfoilProvider } = await loadProvider(t);
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

test("a cancelled run aborts its Tinfoil request and is not retried", async (t) => {
  const { tinfoilProvider, vite } = await loadProvider(t);
  const { cancelRequest, trackRequest } = await vite.ssrLoadModule(
    "/services/ai/requestCancellation.ts"
  );
  t.after(trackRequest("run-1"));
  let requests = 0;
  // A model still thinking: no reply until the SDK's request is aborted.
  globalThis.__tinfoilCreate = ({ signal }) => {
    requests += 1;
    return new Promise((_resolve, reject) => {
      const abort = () =>
        reject(Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" }));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort);
    });
  };

  const call = tinfoilProvider.call({
    text: "## Meeting Transcript\nYou: ship on Friday.",
    model: "gpt-oss-120b",
    agentName: null,
    config: { systemPrompt: "Summarize", maxTokens: 25_000, requestId: "run-1" },
    ctx,
  });
  for (let attempt = 0; requests === 0 && attempt < 400; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  cancelRequest("run-1");

  // Promptly, not at the request deadline.
  const deadline = new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error("still waiting on the request")), 2_000).unref()
  );
  await assert.rejects(Promise.race([call, deadline]), {
    message: "Request cancelled",
    status: 499,
  });
  assert.equal(requests, 1, "an aborted request is never sent again");
});
