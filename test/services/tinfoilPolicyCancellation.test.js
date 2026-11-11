const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { deferred } = require("../helpers/harness/deferred");
const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");

// Loads the renderer model factory over an attestation request that stays open
// until the response ends itself a second later.
async function holdAttestation(t) {
  installBrowserGlobals(t, {
    window: { electronAPI: { getTinfoilKey: async () => "synthetic-key" } },
  });
  const vite = await createRendererServer(t);
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null, appVersion: "1.11.1" });
  const attestation = { vite, usePolicyStore, getAIModel, calls: 0 };
  attestation.receiving = deferred();
  attestation.closed = deferred();
  const server = http.createServer((_request, response) => {
    attestation.calls++;
    const fallback = setTimeout(() => response.end(), 1000);
    response.once("close", () => {
      clearTimeout(fallback);
      attestation.closed.resolve(response.writableFinished);
    });
    response.write('{"domain":');
    attestation.receiving.resolve();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input, init) => {
    assert.equal(String(input), "https://atc.tinfoil.sh/attestation");
    attestation.signal = init?.signal;
    return nativeFetch(`http://127.0.0.1:${server.address().port}/attestation`, init);
  });
  return attestation;
}

for (const restriction of ["provider", "unrelated feature", "user stop"]) {
  test(`model initialization reacts only to its ${restriction} policy change`, async (t) => {
    const attestation = await holdAttestation(t);
    const { vite, usePolicyStore, getAIModel, receiving, closed } = attestation;
    const controller = new AbortController();
    let stream;
    let service;
    if (restriction === "user stop") {
      ({ default: service } = await vite.ssrLoadModule("/services/ReasoningService.ts"));
      t.after(() => service.destroy());
      stream = service.processTextStreamingAI(
        [{ role: "user", content: "synthetic content" }],
        "glm-5-3",
        "tinfoil",
        { systemPrompt: "Answer" },
        {},
        controller.signal
      );
    }
    const result = Promise.allSettled([
      stream
        ? stream.next()
        : getAIModel("tinfoil", "glm-5-3", "synthetic-key", undefined, {
            signal: controller.signal,
          }),
    ]);
    await receiving.promise;
    const policy = defaultDevicePolicy();
    if (restriction === "provider") policy.llm.allowedByokProviders = ["openai"];
    else policy.features.webSearchEnabled = false;
    usePolicyStore.setState({ status: "managed", policy });
    if (restriction === "user stop") controller.abort();
    else if (restriction === "unrelated feature") {
      assert.ok(attestation.signal, "initialization must receive the caller's cancellation signal");
      assert.equal(attestation.signal.aborted, false);
      controller.abort();
    }
    assert.equal(await closed.promise, false);
    const [settled] = await result;
    if (restriction === "user stop") {
      assert.equal(settled.status, "fulfilled");
      assert.deepEqual(settled.value, {
        value: { type: "done", finishReason: "abort" },
        done: false,
      });
      assert.equal((await stream.next()).done, true);
    } else assert.equal(settled.status, "rejected");
    await delay(1100);
    assert.equal(attestation.calls, 1);
  });
}

test("one caller's cancel leaves shared model initialization running for the others", async (t) => {
  const attestation = await holdAttestation(t);
  const { getAIModel, receiving, closed } = attestation;
  const cancelledCaller = new AbortController();
  const [cancelled, other] = [cancelledCaller.signal, new AbortController().signal].map((signal) =>
    Promise.allSettled([getAIModel("tinfoil", "glm-5-3", "synthetic-key", undefined, { signal })])
  );
  await receiving.promise;
  cancelledCaller.abort();
  assert.equal((await cancelled)[0].reason.name, "AbortError");
  assert.equal(await closed.promise, true, "the shared attestation request was cut short");
  const [settled] = await other;
  assert.equal(settled.status, "rejected");
  assert.equal(settled.reason.name, "SyntaxError");
  assert.equal(attestation.calls, 1);
});
