const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { deferred } = require("./harness/deferred");

async function serve(t, handler) {
  const server = http.createServer((request, response) => {
    const fallback = setTimeout(() => response.end(), 1000);
    response.once("close", () => clearTimeout(fallback));
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Redirect only the public attestation URL; retain the real SDK and native transport.
async function attestationServer(t, handler) {
  const url = await serve(t, handler);
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    assert.equal(String(input), "https://attestation.invalid/attestation");
    return nativeFetch(`${url}/attestation`, init);
  });
  return { attestationBundleURL: "https://attestation.invalid" };
}

for (const consumer of ["secure fetch", "chat", "AI SDK", "realtime"]) {
  test(
    `${consumer} cancels active SDK attestation without a retry`,
    { timeout: 5000 },
    async (t) => {
      const sdk = await import("tinfoil");
      const receiving = deferred();
      const closed = deferred();
      let calls = 0;
      const options = await attestationServer(t, (request, response) => {
        calls++;
        assert.equal(request.url, "/attestation");
        assert.equal(request.headers.authorization, undefined);
        response.once("close", () => closed.resolve(response.writableFinished));
        response.write('{"domain":');
        receiving.resolve();
      });
      const controller = new AbortController();
      const signal = controller.signal;
      let pending;
      if (consumer === "chat") {
        const client = new sdk.TinfoilAI({ ...options, apiKey: "synthetic-key" });
        pending = client.chat.completions.create({ model: "test", messages: [] }, { signal });
      } else if (consumer === "AI SDK") {
        pending = sdk.createTinfoilAI("synthetic-key", { ...options, signal });
      } else {
        const client = new sdk.SecureClient(options);
        pending =
          consumer === "realtime"
            ? client.createWebSocket("/v1/realtime", { wsOptions: { signal } })
            : client.fetch("/v1/models", { signal });
      }
      const result = Promise.allSettled([pending]);
      await receiving.promise;
      controller.abort();
      assert.equal(await closed.promise, false);
      const [settled] = await result;
      assert.equal(settled.status, "rejected");
      assert.equal(settled.reason.name, "AbortError");
      await delay(1100);
      assert.equal(calls, 1);
    }
  );
}

for (const stop of ["disconnect", "timeout"]) {
  test(`realtime ${stop} cancels attestation before the socket exists`, async (t) => {
    const { SecureClient } = await import("tinfoil");
    const { TinfoilRealtimeStreaming } = require("../../src/helpers/tinfoilRealtimeStreaming");
    const receiving = deferred();
    const closed = deferred();
    const options = await attestationServer(t, (_request, response) => {
      response.once("close", () => closed.resolve(response.writableFinished));
      response.write('{"domain":');
      receiving.resolve();
    });
    const client = new SecureClient(options);
    const streaming = new TinfoilRealtimeStreaming(({ signal }) =>
      client.createWebSocket("/v1/realtime", { wsOptions: { signal } })
    );
    t.after(() => streaming.cleanup());
    const result = Promise.allSettled([
      streaming.connect({
        apiKey: "synthetic-key",
        connectTimeoutMs: stop === "timeout" ? 100 : 5000,
      }),
    ]);
    await receiving.promise;
    if (stop === "disconnect") await streaming.disconnect();
    assert.equal(await closed.promise, false);
    assert.equal((await result)[0].status, "rejected");
    assert.equal(streaming.isConnecting, false);
    assert.equal(streaming.ws, null);
  });
}

test("one caller's cancel leaves shared attestation running for the others", async (t) => {
  const { SecureClient } = await import("tinfoil");
  const receiving = deferred();
  const closed = deferred();
  let calls = 0;
  const options = await attestationServer(t, (_request, response) => {
    calls++;
    response.once("close", () => closed.resolve(response.writableFinished));
    response.write('{"domain":');
    receiving.resolve();
  });
  const client = new SecureClient(options);
  const dictation = new AbortController();
  const [socket, catalog] = [
    client.createWebSocket("/v1/realtime", { wsOptions: { signal: dictation.signal } }),
    client.fetch("/v1/models", { signal: new AbortController().signal }),
  ].map((pending) => Promise.allSettled([pending]));
  await receiving.promise;
  dictation.abort();
  assert.equal((await socket)[0].reason.name, "AbortError");
  assert.equal(await closed.promise, true, "the shared attestation request was cut short");
  const [settled] = await catalog;
  assert.equal(settled.status, "rejected");
  assert.equal(settled.reason.name, "SyntaxError");
  assert.equal(calls, 1);
});

test("SDK abort during the attestation retry delay prevents the next request", async (t) => {
  const { SecureClient } = await import("tinfoil");
  let calls = 0;
  const receiving = deferred();
  const options = await attestationServer(t, (_request, response) => {
    calls++;
    response.writeHead(503).end();
    receiving.resolve();
  });
  const controller = new AbortController();
  const result = Promise.allSettled([new SecureClient(options).ready(controller.signal)]);
  await receiving.promise;
  await delay(50);
  controller.abort();
  const [settled] = await result;
  assert.equal(settled.status, "rejected");
  assert.equal(settled.reason.name, "AbortError");
  await delay(1100);
  assert.equal(calls, 1);
});

test("an already-cancelled SDK call sends no attestation request", async (t) => {
  const { SecureClient } = await import("tinfoil");
  let calls = 0;
  const options = await attestationServer(t, (_request, response) => {
    calls++;
    response.writeHead(503).end();
  });
  await assert.rejects(
    new SecureClient(options).fetch("/v1/models", {
      signal: AbortSignal.abort(),
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 0);
});

for (const format of ["esm", "cjs"]) {
  for (const method of ["GET", "POST"]) {
    test(`real ${format} EHBP ${method} response closes on cancellation`, async (t) => {
      const { Identity, Transport, PROTOCOL } =
        format === "esm" ? await import("ehbp") : require("ehbp");
      const receiving = deferred();
      const closed = deferred();
      const url = await serve(t, (request, response) => {
        assert.equal(request.method, method);
        if (method === "POST")
          assert.ok(request.headers[PROTOCOL.ENCAPSULATED_KEY_HEADER.toLowerCase()]);
        response.once("close", () => closed.resolve(response.writableFinished));
        request.resume();
        if (method === "GET") response.write('{"data":');
        receiving.resolve();
      });
      const transport = new Transport(await Identity.generate(), new URL(url).host);
      const controller = new AbortController();
      const pending = transport
        .request(`${url}/v1/models`, {
          method,
          signal: controller.signal,
          ...(method === "POST" ? { body: "synthetic private content" } : {}),
        })
        .then((response) => response.text());
      const result = Promise.allSettled([pending]);
      await receiving.promise;
      controller.abort();
      assert.equal(await closed.promise, false);
      const [settled] = await result;
      assert.equal(settled.status, "rejected");
      assert.equal(settled.reason.name, "AbortError");
    });
  }
}

test("a deadline closes an initialized SDK catalog response", async (t) => {
  const { SecureClient } = await import("tinfoil");
  const { Identity } = await import("ehbp");
  const closed = deferred();
  const url = await serve(t, (_request, response) => {
    response.once("close", () => closed.resolve(response.writableFinished));
    response.write('{"data":');
  });
  const client = new SecureClient({ baseURL: url });
  // Fixture for completed verification; exercise the actual default transport factory.
  client.resolvedBaseURL = url;
  client.resolvedEnclaveURL = url;
  client._transport = await client.createTransport(
    await (await Identity.generate()).getPublicKeyHex()
  );
  client.initPromise = Promise.resolve();
  await assert.rejects(
    client
      .fetch("/v1/models", { signal: AbortSignal.timeout(100) })
      .then((response) => response.text()),
    { name: "TimeoutError" }
  );
  assert.equal(await closed.promise, false);
});
