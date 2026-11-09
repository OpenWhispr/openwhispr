const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup(t) {
  const listeners = { chunk: new Set(), end: new Set(), error: new Set() };
  const started = [];
  const cancelled = [];
  const subscribe = (kind) => (listener) => {
    listeners[kind].add(listener);
    return () => listeners[kind].delete(listener);
  };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        startAgentStream: (id) => started.push(id),
        cancelAgentStream: (id) => cancelled.push(id),
        onAgentStreamChunk: subscribe("chunk"),
        onAgentStreamEnd: subscribe("end"),
        onAgentStreamError: subscribe("error"),
      },
    },
  });
  const vite = await createRendererServer(t);
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  (await vite.ssrLoadModule("/stores/policyStore.ts")).usePolicyStore.setState({
    status: "unmanaged",
    policy: null,
  });
  t.after(() => service.destroy());
  const emit = (kind, id, chunk) =>
    listeners[kind].forEach((listener) => listener({ requestId: id, chunk }));
  const start = (signal) =>
    service.processTextStreamingCloud(
      [{ role: "user", content: "hi" }],
      { systemPrompt: "Answer" },
      signal
    );
  return { service, listeners, started, cancelled, emit, start };
}

test("cloud streams run concurrently and abort only their owner's request", async (t) => {
  const fixture = await setup(t);
  const ownerA = new AbortController();
  const ownerB = new AbortController();
  const streamA = fixture.start(ownerA.signal);
  const streamB = fixture.start(ownerB.signal);
  const nextA = streamA.next();
  const nextB = streamB.next();
  await flush();
  assert.equal(fixture.started.length, 2);
  assert.deepEqual(fixture.cancelled, []);
  ownerA.abort();
  await flush();
  assert.deepEqual(fixture.cancelled, [fixture.started[0]]);
  assert.deepEqual((await nextA).value, { type: "done", finishReason: "abort" });
  assert.equal((await streamA.next()).done, true);
  fixture.emit("chunk", fixture.started[1], { type: "content", text: "still answering" });
  assert.equal((await nextB).value.text, "still answering");
  await streamB.return();
  assert.equal(fixture.listeners.chunk.size, 0);
});

test("a pre-aborted cloud stream does not send IPC even before first next", async (t) => {
  const fixture = await setup(t);
  const owner = new AbortController();
  const stream = fixture.start(owner.signal);
  owner.abort();
  const first = stream.next();
  await flush();
  assert.deepEqual(fixture.started, []);
  assert.equal((await first).done, true);
});

for (const transport of ["raw", "ai"]) {
  test(`${transport} streaming observes caller abort during local server setup`, async (t) => {
    const { service } = await setup(t);
    let release;
    globalThis.window.electronAPI.llamaServerStart = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return new Response("data: [DONE]\n\n");
    });
    const owner = new AbortController();
    const args = [
      [{ role: "user", content: "hi" }],
      "qwen3-4b",
      "local",
      { systemPrompt: "Answer" },
    ];
    const stream =
      transport === "raw"
        ? service.processTextStreaming(...args, owner.signal)
        : service.processTextStreamingAI(...args, undefined, owner.signal);
    const pending = stream.next();
    await flush();
    owner.abort();
    release({ success: true, port: 11434 });
    await pending;
    assert.equal(requests, 0);
  });
}

test("cancelAllRequests stops both cloud operations and detaches their listeners", async (t) => {
  const fixture = await setup(t);
  const pending = [fixture.start().next(), fixture.start().next()];
  await flush();
  fixture.service.cancelAllRequests();
  await Promise.all(pending);
  assert.deepEqual(new Set(fixture.cancelled), new Set(fixture.started));
  assert.equal(fixture.listeners.chunk.size, 0);
});

for (const transport of ["raw", "ai"]) {
  test(`${transport} streams keep independent transports and release a consumer that returns early`, async (t) => {
    const { service } = await setup(t);
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      let controller;
      const body = new ReadableStream({
        start(value) {
          controller = value;
        },
      });
      init.signal.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {}
        },
        { once: true }
      );
      requests.push({ signal: init.signal, body, controller });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const start = () => {
      const args = [
        [{ role: "user", content: "hello" }],
        "qwen3-4b",
        "lan",
        { systemPrompt: "Answer", lanUrl: "http://127.0.0.1:11434/v1" },
      ];
      return transport === "raw"
        ? service.processTextStreaming(...args)
        : service.processTextStreamingAI(...args, {});
    };
    const first = start(),
      second = start();
    const a = first.next(),
      b = second.next();
    for (let count = 0; count < 100 && requests.length < 2; count++) await flush();
    assert.equal(requests.length, 2);
    const send = (request, content) =>
      request.controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "qwen3-4b", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
        )
      );
    send(requests[0], "A");
    send(requests[1], "B");
    assert.equal(transport === "raw" ? (await a).value : (await a).value.text, "A");
    assert.equal(transport === "raw" ? (await b).value : (await b).value.text, "B");
    await first.return();
    if (transport === "ai")
      assert.equal(
        requests[0].signal.aborted,
        true,
        "SDK production must stop when its consumer leaves"
      );
    else assert.equal(requests[0].body.locked, false);
    assert.equal(requests[1].signal.aborted, false);
    service.cancelAllRequests();
    await second.return();
  });
}
