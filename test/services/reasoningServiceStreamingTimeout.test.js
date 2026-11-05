const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const contentEvent = (content) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

async function startStream(t, provider, { holdHeaders = false, status = 200 } = {}) {
  // Restore real timers before Vite's server-close hook runs.
  t.after(() => t.mock.timers.reset());
  installBrowserGlobals(t, {
    window: {
      electronAPI: { llamaServerStart: async () => ({ success: true, port: 11434 }) },
    },
  });
  const vite = await createRendererServer(t);
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  t.after(() => service.destroy());
  t.mock.timers.enable({ apis: ["setTimeout"] });

  let signal;
  let controller;
  let sendHeaders;
  let fetchStarted;
  const started = new Promise((resolve) => (fetchStarted = resolve));
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
  });
  const response = new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    const pendingHeaders = new Promise((resolve, reject) => {
      sendHeaders = () => resolve(response);
      signal.addEventListener(
        "abort",
        () => {
          const error = new DOMException("aborted", "AbortError");
          controller.error(error);
          reject(error);
        },
        { once: true }
      );
    });
    if (!holdHeaders) sendHeaders();
    fetchStarted();
    return pendingHeaders;
  });

  const chunks = [];
  // Exercise the no-tools Chat path that delegates to raw streaming.
  const outcome = (async () => {
    for await (const chunk of service.processTextStreamingAI(
      [{ role: "user", content: "Give a long answer." }],
      "qwen3-1.7b-q4_k_m",
      provider,
      {
        systemPrompt: "Answer the user.",
        ...(provider === "lan" ? { lanUrl: "http://127.0.0.1:11434/v1" } : {}),
      }
    )) {
      chunks.push(chunk);
    }
  })().then(
    () => ({ chunks }),
    (error) => ({ error, chunks })
  );
  await Promise.race([
    started,
    outcome.then(({ error }) => {
      throw error || new Error("stream finished before fetch started");
    }),
  ]);
  await flush();
  return {
    service,
    signal,
    body,
    chunks,
    outcome,
    sendHeaders: () => sendHeaders(),
    send: async (data) => {
      controller.enqueue(new TextEncoder().encode(data));
      await flush();
    },
    finish: async (withDone = true) => {
      if (withDone) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
      return outcome;
    },
  };
}

for (const provider of ["local", "lan"]) {
  test(`${provider} chat keeps streaming beyond 60 seconds while bytes arrive`, async (t) => {
    const stream = await startStream(t, provider);
    // 14 × 45 s outlasts the 600 s startup allowance, so only the idle reset keeps it alive.
    for (let i = 0; i < 14; i++) {
      t.mock.timers.tick(45_000);
      assert.equal(stream.signal.aborted, false);
      await stream.send(contentEvent(`Part ${i}. `));
    }
    const result = await stream.finish();
    assert.equal(result.error, undefined);
    assert.equal(result.chunks.filter((chunk) => chunk.type === "content").length, 14);
    assert.deepEqual(result.chunks.at(-1), { type: "done", finishReason: "stop" });
    t.mock.timers.tick(600_000);
    assert.equal(stream.signal.aborted, false, "completion must clear the idle timer");
    assert.equal(stream.body.locked, false);
  });

  for (const holdHeaders of [false, true]) {
    test(`${provider} chat allows slow prefill ${holdHeaders ? "before" : "after"} response headers`, async (t) => {
      const stream = await startStream(t, provider, { holdHeaders });
      t.mock.timers.tick(120_000);
      assert.equal(stream.signal.aborted, false, "self-hosted prefill may take over a minute");
      stream.sendHeaders();
      await stream.send(contentEvent("Answer"));
      assert.equal((await stream.finish()).error, undefined);
    });
  }

  test(`${provider} chat aborts after 60 seconds without bytes following stream activity`, async (t) => {
    const stream = await startStream(t, provider);
    await stream.send(contentEvent("First"));
    t.mock.timers.tick(45_000);
    await stream.send(contentEvent("Second"));
    t.mock.timers.tick(59_999);
    assert.equal(stream.signal.aborted, false);
    t.mock.timers.tick(1);
    const { error } = await stream.outcome;
    assert.equal(stream.signal.aborted, true);
    if (provider === "lan") {
      assert.equal(error.code, "PROVIDER_TIMEOUT");
      assert.equal(error.messageKey, "providerErrors.selfHosted.timeout");
    } else {
      assert.equal(error.message, "Streaming request timed out");
    }
    assert.equal(stream.body.locked, false);
  });
}

test("stream activity includes split SSE lines, keepalives and filtered thinking", async (t) => {
  const stream = await startStream(t, "local");
  // The first bytes arrive at 595 s, so each later gap only survives through the idle reset.
  t.mock.timers.tick(550_000);
  for (const data of [
    ": keepalive\n\n",
    "data: ",
    '{"choices":[',
    '{"delta":{"content":"<think>hidden"}}]}\n\n',
  ]) {
    t.mock.timers.tick(45_000);
    assert.equal(stream.signal.aborted, false);
    await stream.send(data);
  }
  assert.deepEqual(stream.chunks, [], "hidden reasoning is activity even without visible output");
  t.mock.timers.tick(45_000);
  await stream.send(contentEvent("</think>Answer"));
  assert.equal((await stream.finish(false)).error, undefined);
  t.mock.timers.tick(600_000);
  assert.equal(stream.signal.aborted, false, "EOF must clear the idle timer");
});

test("a local model that never sends bytes still times out after the startup allowance", async (t) => {
  const stream = await startStream(t, "local", { holdHeaders: true });
  t.mock.timers.tick(599_999);
  assert.equal(stream.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await stream.outcome).error.message, "Streaming request timed out");
});

test("cancelling a raw stream ends normally", async (t) => {
  const stream = await startStream(t, "local");
  await stream.send(contentEvent("Partial answer"));
  stream.service.cancelActiveStream();
  assert.equal((await stream.outcome).error, undefined);
  assert.equal(stream.body.locked, false);
});

test("an error response whose body stalls still times out", async (t) => {
  const stream = await startStream(t, "local", { status: 500 });
  t.mock.timers.tick(599_999);
  assert.equal(stream.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await stream.outcome).error.message, "Streaming request timed out");
});
