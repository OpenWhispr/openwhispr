const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { deferred } = require("./harness/deferred");

async function verifiedClientFixture(t, beforeReady = async () => {}) {
  const { SecureClient } = await import("tinfoil");
  const { Identity } = await import("ehbp");
  const publicKey = await (await Identity.generate()).getPublicKeyHex();
  // Replace attestation only; retain shared initialization and the real encrypted transport.
  t.mock.method(SecureClient.prototype, "initSecureClient", async function () {
    await beforeReady();
    this.resolvedBaseURL = "https://enclave.invalid";
    this.resolvedEnclaveURL = this.resolvedBaseURL;
    this._transport = await this.createTransport(publicKey);
  });
  const modulePath = require.resolve("../../src/helpers/tinfoilSecureClient");
  delete require.cache[modulePath];
  t.after(() => delete require.cache[modulePath]);
  return require(modulePath);
}

test("cancelled Tinfoil work never starts attestation", async (t) => {
  let attestations = 0;
  const { tinfoilSecureFetch } = await verifiedClientFixture(t, async () => attestations++);
  t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  await assert.rejects(tinfoilSecureFetch("/v1/models", { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
  assert.equal(attestations, 0);
});

test("revocation during shared attestation prevents audio upload but leaves permitted work alive", async (t) => {
  const entered = deferred();
  const released = deferred();
  let attestations = 0;
  const { tinfoilSecureFetch } = await verifiedClientFixture(t, async () => {
    attestations++;
    entered.resolve();
    await released.promise;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (request) => {
    requests.push(request);
    return new Response('{"data":[]}');
  });
  const controller = new AbortController();
  const cancelled = tinfoilSecureFetch("/v1/audio/transcriptions", {
    method: "POST",
    body: "synthetic private audio",
    signal: controller.signal,
  });
  const settled = Promise.allSettled([cancelled]);
  await entered.promise;
  const catalog = tinfoilSecureFetch("/v1/models");
  controller.abort(new Error("DEVICE_POLICY_BLOCKED"));
  released.resolve();
  assert.deepEqual(await (await catalog).json(), { data: [] });
  assert.equal((await settled)[0].reason, controller.signal.reason);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    ["/v1/models"]
  );
  assert.equal(attestations, 1);
});

for (const format of ["esm", "cjs"]) {
  test(`${format} EHBP stops an upload revoked during encryption`, async (t) => {
    const { Identity, Transport } = format === "esm" ? await import("ehbp") : require("ehbp");
    const identity = await Identity.generate();
    const controller = new AbortController();
    const encrypt = identity.encryptRequestWithContext.bind(identity);
    t.mock.method(identity, "encryptRequestWithContext", async (request) => {
      const encrypted = await encrypt(request);
      controller.abort();
      return encrypted;
    });
    let uploads = 0;
    t.mock.method(globalThis, "fetch", async () => {
      uploads++;
      return new Response();
    });
    const transport = new Transport(identity, "enclave.invalid");
    await assert.rejects(
      transport.request("https://enclave.invalid/v1/audio/transcriptions", {
        method: "POST",
        body: "synthetic private audio",
        signal: controller.signal,
      }),
      { name: "AbortError" }
    );
    assert.equal(uploads, 0);
  });

  for (const method of ["GET", "POST"]) {
    test(`${format} EHBP cancels an active ${method} response`, { timeout: 5000 }, async (t) => {
      const { Identity, Transport, PROTOCOL } =
        format === "esm" ? await import("ehbp") : require("ehbp");
      const receiving = deferred();
      const closed = deferred();
      const server = http.createServer((request, response) => {
        assert.equal(request.method, method);
        if (method === "POST") {
          assert.ok(request.headers[PROTOCOL.ENCAPSULATED_KEY_HEADER.toLowerCase()]);
        }
        response.once("close", () => closed.resolve(response.writableFinished));
        request.resume();
        if (method === "GET") response.write('{"data":');
        receiving.resolve();
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const url = `http://127.0.0.1:${server.address().port}`;
      const transport = new Transport(await Identity.generate(), new URL(url).host);
      const controller = new AbortController();
      // Request inputs must preserve cancellation too, including a bodyless response stream.
      const request = new Request(`${url}/v1/models`, {
        method,
        signal: controller.signal,
        ...(method === "POST" ? { body: "synthetic private content" } : {}),
      });
      const pending = transport.request(request).then((response) => response.text());
      const settled = Promise.allSettled([pending]);
      await receiving.promise;
      controller.abort();
      assert.equal(await closed.promise, false);
      const [result] = await settled;
      assert.equal(result.status, "rejected");
      assert.equal(result.reason.name, "AbortError");
    });
  }
}
