const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("./rendererTestHarness");

const snapshot = (overrides = {}) => ({
  success: true,
  status: "unmanaged",
  accountId: null,
  authGeneration: 0,
  revision: 1,
  managed: false,
  policy: null,
  deviceReady: true,
  deviceManaged: false,
  workspaceManaged: false,
  requireSignIn: false,
  localOnly: false,
  ...overrides,
});

async function boot(t, read = async () => snapshot()) {
  let listener;
  installBrowserGlobals(t, {
    window: {
      location: { href: "file:///app/index.html", search: "?panel=true" },
      electronAPI: {
        getEffectivePolicy: read,
        onEffectivePolicyChanged: (callback) => {
          listener = callback;
          return () => {};
        },
        getAppVersion: async () => ({ version: "1.11.1" }),
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "managed-device-lifecycle-" });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  await usePolicyStore.getState().bootstrap();
  return {
    store: usePolicyStore,
    vite,
    emit: async (value) => {
      listener(value);
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("device management survives sign-out and an invalid policy recovers without stale errors", async (t) => {
  let current = snapshot({
    status: "error",
    success: false,
    deviceManaged: true,
    managed: true,
    code: "DEVICE_POLICY_INVALID",
  });
  const { store, emit } = await boot(t, async () => current);
  assert.equal(store.getState().status, "error");
  const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");
  current = snapshot({
    revision: 2,
    status: "managed",
    managed: true,
    deviceManaged: true,
    policy: defaultDevicePolicy(),
    localOnly: true,
  });
  await emit(current);
  assert.equal(store.getState().code, undefined);
  store.getState().clearPolicy();
  await store.getState().bootstrap();
  assert.equal(store.getState().localOnly, true);
  assert.equal(store.getState().deviceManaged, true);
  await emit(snapshot({ revision: 1 }));
  assert.equal(store.getState().localOnly, true);
});

test("a failed older read cannot erase a newer device broadcast", async (t) => {
  let rejectRead;
  let reads = 0;
  const { store, emit } = await boot(t, () =>
    ++reads === 1
      ? Promise.resolve(snapshot())
      : new Promise((_resolve, reject) => {
          rejectRead = reject;
        })
  );
  const pending = store.getState().bootstrap();
  await emit(snapshot({ revision: 2, localOnly: true, deviceManaged: true }));
  rejectRead(new Error("Old IPC failed"));
  await pending;
  assert.equal(store.getState().localOnly, true);
  assert.equal(store.getState().status, "unmanaged");
});

test("renderer transport refuses saved credentials and retires a response when policy tightens", async (t) => {
  const { store, vite } = await boot(t);
  const calls = [];
  let requestSignal;
  let finishBody;
  globalThis.window.fetch = async (url, init) => {
    calls.push(String(url));
    requestSignal = init.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          finishBody = controller;
        },
      })
    );
  };
  const { installPolicyNetworkGuard } = await vite.ssrLoadModule("/lib/policyNetwork.ts");
  t.after(installPolicyNetworkGuard());
  const response = await globalThis.window.fetch("https://api.openai.com/v1/responses", {
    headers: { Authorization: "Bearer saved-key" },
  });
  const body = response.text();
  store.setState({ localOnly: true, deviceManaged: true });
  finishBody.enqueue(new TextEncoder().encode("late cloud output"));
  finishBody.close();
  await assert.rejects(body, /Blocked by device policy/);
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(
    globalThis.window.fetch("https://api.openai.com/v1/models"),
    /Blocked by device policy/
  );
  assert.equal(calls.length, 1);
  // Local model endpoints remain available.
  const local = await globalThis.window.fetch("http://127.0.0.1:8080/completion");
  await local.body.cancel();
  assert.equal(calls.length, 2);
});

test("an existing renderer model cannot send a later tool step after policy revocation", async (t) => {
  for (const restriction of ["mode", "provider", "agent"]) {
    await t.test(restriction, async (t) => {
      const { vite, emit } = await boot(t);
      const calls = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        return Response.json({
          id: "chat-1",
          created: 1,
          model: "chat-model",
          choices: [
            { index: 0, message: { role: "assistant", content: "allowed" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      };
      t.after(() => {
        globalThis.fetch = originalFetch;
      });
      const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
      const model = await getAIModel(
        "custom",
        "chat-model",
        "saved-key",
        "https://provider.example.test/v1",
        { requiresAgent: true }
      );
      const options = {
        prompt: [{ role: "user", content: [{ type: "text", text: "private tool output" }] }],
      };
      await model.doGenerate(options);
      assert.equal(calls.length, 1);
      const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
      if (restriction === "mode") policy.llm.allowedModes = ["local"];
      else if (restriction === "provider") policy.llm.allowedByokProviders = ["openai"];
      else policy.features.agentEnabled = false;
      await emit(snapshot({ revision: 2, status: "managed", managed: true, policy }));
      await assert.rejects(model.doGenerate(options));
      assert.equal(calls.length, 1);
    });
  }
});

test("renderer model revocation aborts pending generation and an open stream", async (t) => {
  const { vite, emit } = await boot(t);
  const { guardLanguageModel } = await vite.ssrLoadModule("/services/ai/policyModel.ts");
  const { assertReasoningAllowedByPolicy } = await vite.ssrLoadModule(
    "/services/reasoningPolicy.ts"
  );
  const { MockLanguageModelV3 } = require("ai/test");
  let generateSignal;
  let streamSignal;
  let finish;
  let cancelled = false;
  const model = guardLanguageModel(
    new MockLanguageModelV3({
      doGenerate: async (options) => {
        generateSignal = options.abortSignal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      doStream: async (options) => {
        streamSignal = options.abortSignal;
        return {
          stream: new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    }),
    () => assertReasoningAllowedByPolicy("custom", "providers")
  );
  const generating = model.doGenerate({ prompt: [] });
  const { stream } = await model.doStream({ prompt: [] });
  const reading = stream.getReader().read();
  const rejectedGeneration = assert.rejects(generating);
  const rejectedRead = assert.rejects(reading);
  const policy = require("../../src/helpers/managedDevicePolicy").defaultDevicePolicy();
  policy.llm.allowedByokProviders = ["openai"];
  await emit(snapshot({ revision: 2, status: "managed", managed: true, policy }));
  assert.equal(generateSignal.aborted, true);
  assert.equal(streamSignal.aborted, true);
  finish({ content: [{ type: "text", text: "late private output" }], warnings: [] });
  await rejectedGeneration;
  await rejectedRead;
  assert.equal(cancelled, true);
});

test("required-sign-in renderer can discover email without allowing unrelated API traffic", async (t) => {
  const { store, vite } = await boot(t, async () =>
    snapshot({
      success: false,
      status: "error",
      deviceManaged: true,
      managed: true,
      requireSignIn: true,
      code: "POLICY_SIGN_IN_REQUIRED",
    })
  );
  const requests = [];
  globalThis.window.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({ exists: true });
  };
  const { installPolicyNetworkGuard } = await vite.ssrLoadModule("/lib/policyNetwork.ts");
  t.after(installPolicyNetworkGuard());
  assert.deepEqual(
    await (
      await globalThis.window.fetch("https://auth.openwhispr.com/api/check-user", { method: "POST" })
    ).json(),
    { exists: true }
  );
  for (const url of [
    "https://other.example/api/check-user",
    "https://api.openwhispr.com/api/reason",
  ]) {
    await assert.rejects(globalThis.window.fetch(url), /Blocked by device policy/);
  }
  store.setState({ localOnly: true });
  await assert.rejects(
    globalThis.window.fetch("https://auth.openwhispr.com/api/check-user"),
    /Blocked by device policy/
  );
  assert.equal(requests.length, 1);
});
