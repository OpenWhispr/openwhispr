const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { deferred } = require("../helpers/harness/deferred");
const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");

for (const restriction of ["provider", "unrelated feature", "user stop"]) {
  test(`model initialization reacts only to its ${restriction} policy change`, async (t) => {
    installBrowserGlobals(t, {
      window: { electronAPI: { getTinfoilKey: async () => "synthetic-key" } },
    });
    const vite = await createRendererServer(t);
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
    usePolicyStore.setState({ status: "unmanaged", policy: null, appVersion: "1.11.1" });
    const receiving = deferred();
    const closed = deferred();
    let calls = 0;
    const server = http.createServer((_request, response) => {
      calls++;
      const fallback = setTimeout(() => response.end(), 1000);
      response.once("close", () => {
        clearTimeout(fallback);
        closed.resolve(response.writableFinished);
      });
      response.write('{"domain":');
      receiving.resolve();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const nativeFetch = globalThis.fetch;
    let initializationSignal;
    t.mock.method(globalThis, "fetch", (input, init) => {
      assert.equal(String(input), "https://atc.tinfoil.sh/attestation");
      initializationSignal = init?.signal;
      return nativeFetch(`http://127.0.0.1:${server.address().port}/attestation`, init);
    });
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
      assert.ok(
        initializationSignal,
        "initialization must receive the caller's cancellation signal"
      );
      assert.equal(initializationSignal.aborted, false);
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
    assert.equal(calls, 1);
  });
}
