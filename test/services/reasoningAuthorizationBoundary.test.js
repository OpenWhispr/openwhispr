const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAgentStreamBridge() {
  const startCalls = [];
  const cancelCalls = [];
  const listeners = { chunk: null, error: null, end: null };
  const subscribe = (kind, callback) => {
    listeners[kind] = callback;
    return () => {
      if (listeners[kind] === callback) listeners[kind] = null;
    };
  };
  return {
    electronAPI: {
      startAgentStream: (...args) => startCalls.push(args),
      cancelAgentStream: (requestId) => cancelCalls.push(requestId),
      onAgentStreamChunk: (callback) => subscribe("chunk", callback),
      onAgentStreamError: (callback) => subscribe("error", callback),
      onAgentStreamEnd: (callback) => subscribe("end", callback),
    },
    startCalls,
    cancelCalls,
  };
}

async function loadReasoning(t, cachePrefix, electronAPI = {}) {
  installBrowserGlobals(t, { window: { electronAPI } });
  const vite = await createRendererServer(t, { cachePrefix });
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({
    accountId: "account-a",
    authGeneration: 1,
    status: "unmanaged",
    managed: false,
    appVersion: "1.8.4",
    policy: null,
  });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: null,
    lastKnownLocalModels: null,
    lastKnownLocalModelsKnown: true,
    error: null,
    failClosed: false,
  });
  t.after(() => reasoningService.destroy());
  return { reasoningService, useEnterpriseIdentityStore };
}

function switchIdentity(useEnterpriseIdentityStore) {
  useEnterpriseIdentityStore.setState({
    accountId: "account-b",
    workspaceId: "workspace-b",
    authGeneration: 2,
    status: "ready",
    config: null,
    lastKnownLocalModels: null,
    lastKnownLocalModelsKnown: true,
    error: null,
    failClosed: false,
  });
}

const waitForMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("one-shot reasoning never dispatches after identity changes during key lookup", async (t) => {
  const key = deferred();
  const { reasoningService, useEnterpriseIdentityStore } = await loadReasoning(
    t,
    "openwhispr-reasoning-auth-key-race-test-",
    { getOpenAIKey: () => key.promise }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ output_text: "must not run" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const operation = reasoningService.processText("hello", "gpt-4.1", null, {
    provider: "openai",
  });
  await waitForMicrotasks();
  switchIdentity(useEnterpriseIdentityStore);
  key.resolve("old-identity-key");

  await assert.rejects(operation, { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
  assert.equal(fetchCalls, 0);
});

test("one-shot reasoning never starts an endpoint fallback after the boundary changes", async (t) => {
  const { reasoningService, useEnterpriseIdentityStore } = await loadReasoning(
    t,
    "openwhispr-reasoning-auth-retry-race-test-",
    { getOpenAIKey: async () => "old-identity-key" }
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let postCalls = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "GET") {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    postCalls += 1;
    if (postCalls === 1) {
      switchIdentity(useEnterpriseIdentityStore);
      return new Response(JSON.stringify({ error: "temporary" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "late" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await assert.rejects(
    reasoningService.processText("hello", "gpt-4.1", null, { provider: "openai" }),
    { code: "AUTHORIZATION_BOUNDARY_CHANGED" }
  );
  assert.equal(postCalls, 1);
});

test("cloud chat captures authorization before the generator's first next", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService, useEnterpriseIdentityStore } = await loadReasoning(
    t,
    "openwhispr-cloud-auth-pre-next-race-test-",
    bridge.electronAPI
  );
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hello" }],
    { systemPrompt: "Answer the user." }
  );

  switchIdentity(useEnterpriseIdentityStore);
  const first = assert.rejects(stream.next(), { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
  await waitForMicrotasks();
  const started = bridge.startCalls.length;
  reasoningService.cancelActiveStream();
  await first;

  assert.equal(started, 0);
});

test("identity changes cancel an active cloud chat before another model step", async (t) => {
  const bridge = createAgentStreamBridge();
  const { reasoningService, useEnterpriseIdentityStore } = await loadReasoning(
    t,
    "openwhispr-cloud-auth-active-race-test-",
    bridge.electronAPI
  );
  const stream = reasoningService.processTextStreamingCloud(
    [{ role: "user", content: "hello" }],
    { systemPrompt: "Answer the user." }
  );
  const pending = stream.next();
  await waitForMicrotasks();
  assert.equal(bridge.startCalls.length, 1, "fixture setup: cloud stream must be active");

  switchIdentity(useEnterpriseIdentityStore);
  await waitForMicrotasks();
  const automaticCancelCalls = [...bridge.cancelCalls];
  reasoningService.cancelActiveStream();
  await pending;

  assert.equal(automaticCancelCalls.length, 1);
  assert.equal(automaticCancelCalls[0], bridge.startCalls[0][0]);
  assert.equal(bridge.startCalls.length, 1);
});
