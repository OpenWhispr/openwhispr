const test = require("node:test");
const assert = require("node:assert/strict");

const ctx = {
  getApiKey: async () => "test-key",
  getSystemPrompt: () => "Clean the transcript",
  getCustomDictionary: () => [],
  getPreferredLanguage: () => "en",
  getUiLanguage: () => "en",
  calculateMaxTokens: () => 4096,
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = {
  output: [{ type: "message", content: [{ type: "output_text", text: "Cleaned" }] }],
};
const chatReply = { choices: [{ message: { role: "assistant", content: "Cleaned" } }] };

function pendingBody(signal) {
  let stream;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        stream = controller;
      },
    })
  );
  signal.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")), {
    once: true,
  });
  return response;
}

async function setup(t, name, fetchResponse, config = {}) {
  const { openaiProvider } = await import("../../src/services/ai/inferenceProviders/openai.ts");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requested = [];
  globalThis.fetch = async (url, init = {}) => {
    requested.push(String(url));
    return fetchResponse(String(url), init);
  };
  const call = () =>
    openaiProvider.call({
      text: "raw transcript",
      model: "cleanup-model",
      agentName: null,
      config: {
        provider: "custom",
        customApiKey: "test-key",
        baseUrl: `https://${name}.example/v1`,
        ...config,
      },
      ctx,
    });
  return { request: call(), call, requested };
}

for (const { label, name, config, deadline, urls } of [
  {
    label: "a custom endpoint's 30s cleanup",
    name: "body-cleanup",
    config: {},
    deadline: 30_000,
    urls: ["https://body-cleanup.example/v1/models", "https://body-cleanup.example/v1/responses"],
  },
  {
    label: "a custom endpoint's 600s note",
    name: "body-note",
    config: { inferenceScope: "noteFormatting" },
    deadline: 600_000,
    urls: ["https://body-note.example/v1/models", "https://body-note.example/v1/responses"],
  },
  // OpenRouter sends its 200 headers as soon as a provider accepts the request,
  // before the model generates, so the body read is the whole generation.
  {
    label: "OpenRouter's 30s cleanup",
    name: "body-openrouter",
    config: { provider: "openrouter" },
    deadline: 30_000,
    urls: ["https://openrouter.ai/api/v1/chat/completions"],
  },
]) {
  test(`successful response body retains ${label} deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    const { request, requested } = await setup(
      t,
      name,
      (url, init) => {
        if (url.endsWith("/models")) return json({}, 404);
        signal = init.signal;
        return pendingBody(signal);
      },
      config
    );
    let error;
    const outcome = request.catch((cause) => {
      error = cause;
    });
    await settle();
    assert.deepEqual(requested, urls);
    t.mock.timers.tick(deadline - 1);
    await settle();
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(signal.aborted, true, "body consumption must remain covered by the deadline");
    await outcome;
    assert.equal(error?.code, "PROVIDER_TIMEOUT");
    assert.match(
      error?.cause?.message ?? "",
      new RegExp(`Request timed out after ${deadline / 1000}s`)
    );
    assert.deepEqual(requested, urls, "an expired body must not trigger fallback or retry");
  });
}

test("model discovery body times out and permits the inference request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const { request, requested } = await setup(t, "probe-body", (url, init) => {
    if (url.endsWith("/models")) {
      signal = init.signal;
      return pendingBody(signal);
    }
    return json(reply);
  });
  await settle();
  assert.equal(requested.length, 1);
  t.mock.timers.tick(2_000);
  await settle();
  assert.equal(signal.aborted, true, "discovery deadline must cover its body");
  assert.equal(await request, "Cleaned");
  assert.equal(requested.length, 2);
});

// A llama.cpp server whose model list outlives the probe deadline is not
// detected, so its first request falls back from /responses once and the
// chat preference it learns keeps later requests off both extra round trips.
test("an undetected llama.cpp server learns chat from its first request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const base = "https://slow-llamacpp.example/v1";
  const { request, call, requested } = await setup(t, "slow-llamacpp", (url, init) => {
    if (url.endsWith("/models")) return pendingBody(init.signal);
    if (url.endsWith("/responses")) return json({ error: { message: "not found" } }, 404);
    return json(chatReply);
  });
  await settle();
  t.mock.timers.tick(2_000);
  assert.equal(await request, "Cleaned");
  assert.deepEqual(requested, [`${base}/models`, `${base}/responses`, `${base}/chat/completions`]);

  requested.length = 0;
  assert.equal(await call(), "Cleaned");
  assert.deepEqual(requested, [`${base}/chat/completions`]);
});

// The tests below pass without the fix too: they pin what it must not change.

test("a complete response body resolves and disposes the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const { request } = await setup(t, "complete-body", (url, init) => {
    if (url.endsWith("/models")) return json({}, 404);
    signal = init.signal;
    return json(reply);
  });
  assert.equal(await request, "Cleaned");
  t.mock.timers.tick(30_000);
  assert.equal(signal.aborted, false);
});

for (const kind of ["malformed", "dropped"]) {
  test(`${kind} successful body is retried on /responses without falling back to chat`, async (t) => {
    const { RETRY_CONFIG } = await import("../../src/config/constants.ts");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const base = `https://${kind}-body.example/v1`;
    const { request, requested } = await setup(t, `${kind}-body`, (url) => {
      if (url.endsWith("/models")) return json({}, 404);
      if (kind === "malformed") return new Response("{");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("body dropped"));
          },
        })
      );
    });
    const rejected = assert.rejects(request);
    let delay = RETRY_CONFIG.INITIAL_DELAY;
    for (let retry = 0; retry < RETRY_CONFIG.MAX_RETRIES; retry++) {
      await settle();
      t.mock.timers.tick(delay);
      delay = Math.min(delay * RETRY_CONFIG.BACKOFF_MULTIPLIER, RETRY_CONFIG.MAX_DELAY);
    }
    await rejected;
    assert.deepEqual(requested, [
      `${base}/models`,
      ...Array(RETRY_CONFIG.MAX_RETRIES + 1).fill(`${base}/responses`),
    ]);
  });
}
