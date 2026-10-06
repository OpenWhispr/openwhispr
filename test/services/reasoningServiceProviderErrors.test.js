const test = require("node:test");
const assert = require("node:assert/strict");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadReasoningService(t, cachePrefix) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: { getOpenAIKey: async () => "sk-test", getGeminiKey: async () => "AIza-test" },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  t.after(() => reasoningService.destroy());
  return reasoningService;
}

function mockFetch(t, behavior) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return behavior(...args);
  };
  return calls;
}

// LAN cleanup goes through callChatCompletionsApi, the path shared with Groq and Corti.
const runLanCleanup = (reasoningService) =>
  reasoningService.processText("clean this up", "some-model", null, {
    lanUrl: "http://127.0.0.1:11434/v1",
  });

test("a BYOK request that hits its client-side deadline surfaces as PROVIDER_TIMEOUT after one attempt", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-provider-timeout-test-");
  // What fetch rejects with once the request's AbortController fires.
  const calls = mockFetch(t, async () => {
    throw new DOMException("The operation was aborted.", "AbortError");
  });

  const error = await runLanCleanup(reasoningService).then(
    () => assert.fail("expected a timeout"),
    (err) => err
  );

  assert.equal(calls.length, 1, "a deadline is never retried");
  assert.equal(error.code, "PROVIDER_TIMEOUT");
  assert.equal(error.messageKey, "providerErrors.selfHosted.timeout");
  assert.equal(error.surface, "llm");
  assert.doesNotMatch(error.message, /timed out after/);
});

test("a stopped self-hosted server surfaces as PROVIDER_NO_RESPONSE, still retried", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-provider-unreachable-test-");
  const calls = mockFetch(t, async () => {
    throw new TypeError("Failed to fetch");
  });
  // Skip withRetry's real backoff delays.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let settled = false;
  const outcome = runLanCleanup(reasoningService).then(
    () => assert.fail("expected a network failure"),
    (err) => err
  );
  outcome.finally(() => {
    settled = true;
  });
  for (let i = 0; i < 100 && !settled; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10_000);
  }
  const error = await outcome;

  assert.equal(calls.length, 4, "a network failure keeps its retries");
  assert.equal(error.code, "PROVIDER_NO_RESPONSE");
  assert.equal(error.messageKey, "providerErrors.selfHosted.noResponse");
  assert.equal(error.surface, "llm");
});

test("a stopped LAN server on a chat without tools is classified, not a raw fetch error", async (t) => {
  const reasoningService = await loadReasoningService(t, "openwhispr-lan-stream-fetch-test-");
  mockFetch(t, async () => {
    throw new TypeError("Failed to fetch");
  });

  const error = await (async () => {
    for await (const _chunk of reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "some-model",
      "lan",
      { systemPrompt: "be brief", lanUrl: "http://127.0.0.1:11434/v1" }
    )) {
      // drain
    }
  })().then(
    () => assert.fail("expected the stream to fail"),
    (err) => err
  );

  assert.equal(error.code, "PROVIDER_NO_RESPONSE");
  assert.equal(error.messageKey, "providerErrors.selfHosted.noResponse");
  assert.equal(error.surface, "llm");
});

for (const { provider, model, displayName } of [
  { provider: "openai", model: "gpt-5-mini", displayName: "OpenAI" },
  { provider: "gemini", model: "gemini-3.5-flash", displayName: "Gemini" },
]) {
  test(`a ${displayName} cleanup that hits its deadline surfaces as PROVIDER_TIMEOUT after one attempt`, async (t) => {
    const reasoningService = await loadReasoningService(
      t,
      `openwhispr-provider-timeout-${provider}-test-`
    );
    const calls = mockFetch(t, async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const error = await reasoningService
      .processText("clean this up", model, null, { provider })
      .then(
        () => assert.fail("expected a timeout"),
        (err) => err
      );

    // OpenAI's base is probed once with a GET /models before the request.
    const attempts = calls.filter(([, init]) => init?.method === "POST");
    assert.equal(attempts.length, 1, "a deadline is never retried");
    assert.equal(error.code, "PROVIDER_TIMEOUT");
    assert.equal(error.messageParams.provider, displayName);
    assert.equal(error.surface, "llm");
  });
}
