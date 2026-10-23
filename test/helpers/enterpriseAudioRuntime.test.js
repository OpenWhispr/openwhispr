const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createEnterpriseAudioRuntime,
  createEnterpriseAudioRequestResolver,
  createEnterpriseAudioConfigChangedError,
} = require("../../src/helpers/enterpriseAudioRuntime");

function setup(overrides = {}) {
  let binding = null;
  const identity = { accountId: "account-a", authGeneration: 1, signedIn: true };
  const calls = [];
  const request = createEnterpriseAudioRequestResolver({
    getIdentity: () => ({ ...identity }),
    getBinding: () => binding,
    setBinding: (next) => {
      binding = next;
    },
    getAuthHeaders: async () => ({ Authorization: "Bearer local-test" }),
    getWorkspaces: async () => {
      calls.push("membership");
      return [{ id: "workspace-a" }];
    },
    getConfig: async (input) => {
      calls.push("config");
      return {
        success: true,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        authGeneration: input.expectedAuthGeneration,
        config: { generation: 3, providers: [] },
      };
    },
    ...overrides,
  });
  return { request, identity, calls };
}

const context = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 };

test("cold meeting requests load authoritative membership and enterprise config before routing", async () => {
  const fixture = setup();
  const request = await fixture.request({}, context, true);
  assert.equal(request.workspaceId, "workspace-a");
  assert.deepEqual(fixture.calls, ["membership", "config"]);
  await fixture.request({}, { ...context, generation: 3 });
  assert.deepEqual(fixture.calls, ["membership", "config"]);
  await assert.rejects(fixture.request({}, { ...context, generation: 2 }), {
    code: "AUTH_CONTEXT_CHANGED",
  });
});

test("unknown or unresolved signed-in workspaces cannot take a personal meeting route", async () => {
  const fixture = setup();
  await assert.rejects(fixture.request({}, undefined, true), { code: "AUTH_CONTEXT_CHANGED" });
  await assert.rejects(fixture.request({}, { ...context, workspaceId: "other-workspace" }, true), {
    code: "AUTH_CONTEXT_CHANGED",
  });
  assert.equal(fixture.calls.includes("config"), false);
});

test("personal users without workspaces and signed-out guests retain personal routing", async () => {
  const fixture = setup({ getWorkspaces: async () => [] });
  assert.equal(await fixture.request({}, undefined, true), null);
  fixture.identity.signedIn = false;
  fixture.identity.accountId = null;
  assert.equal(await fixture.request({}, undefined, true), null);
});

test("identity changes during workspace lookup cannot install a stale binding", async () => {
  let finish;
  const fixture = setup({
    getWorkspaces: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = fixture.request({}, context, true);
  await new Promise(setImmediate);
  fixture.identity.authGeneration++;
  finish([{ id: "workspace-a" }]);
  await assert.rejects(pending, { code: "AUTH_CONTEXT_CHANGED" });
  assert.deepEqual(fixture.calls, []);
});

test("a workspace switch during lookup cannot replace the newer workspace binding", async () => {
  let finish;
  let revision = 1;
  const fixture = setup({
    getScopeRevision: () => revision,
    getWorkspaces: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = fixture.request({}, context, true);
  await new Promise(setImmediate);
  revision++;
  finish([{ id: "workspace-a" }]);
  await assert.rejects(pending, { code: "AUTH_CONTEXT_CHANGED" });
  assert.deepEqual(fixture.calls, []);
});

function audioRuntime({
  provider = "openai-compatible",
  tokenProvider = async () => "token",
  request,
} = {}) {
  const credentials = { generation: 1, read: async () => "device-key" };
  const retirement = new AbortController();
  const calls = [];
  const resolved = {
    managed: true,
    provider,
    generation: 1,
    version: 1,
    identity: { accountId: "account-a", workspaceId: "workspace-a" },
    config: {
      endpoint: "https://example.openai.azure.com",
      apiVersion: "v1",
      transcription: { defaultDeployment: "speech" },
      batch: {
        endpoint: "https://gateway.test/transcribe",
        defaultDeployment: "speech",
        authentication: { type: "bearer", credentialSlot: "http" },
      },
    },
    tokenProvider,
  };
  const runtime = createEnterpriseAudioRuntime({
    resolveProvider: async () => resolved,
    credentials,
    getRetirementSignal: () => retirement.signal,
    transport: {
      request: async (...args) => {
        calls.push(args);
        return request ? request(...args) : new Response('{"text":"transcript"}');
      },
    },
  });
  return { runtime, credentials, retirement, calls };
}

test(
  "cancelling an upload during Entra acquisition returns before the shared token resolves",
  { timeout: 1000 },
  async (t) => {
    let release;
    const fixture = audioRuntime({
      provider: "azure",
      tokenProvider: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    t.after(() => release?.("late-token"));
    const profile = await fixture.runtime.resolve({});
    const controller = new AbortController();
    const pending = profile.request({ signal: controller.signal });
    await new Promise(setImmediate);
    assert.equal(typeof release, "function");
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    release("late-token");
    await new Promise(setImmediate);
    assert.equal(fixture.calls.length, 0);
  }
);

test("resolved audio profiles cannot adopt rotated credentials", async () => {
  const fixture = audioRuntime();
  const profile = await fixture.runtime.resolve({});
  assert.equal(profile.signal, fixture.retirement.signal);
  await profile.request({});
  fixture.credentials.generation++;
  await assert.rejects(profile.request({}), { code: "MANAGED_CONFIG_CHANGED" });
  fixture.retirement.abort();
  await assert.rejects(profile.request({}), { name: "AbortError" });
  assert.equal(fixture.calls.length, 1);
});

test("retirement preserves the managed error when the HTTP transport wraps cancellation", async () => {
  const fixture = audioRuntime({
    request: (_endpoint, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("The operation was aborted"), {
                code: "ABORT_ERR",
                cause: signal.reason,
              })
            ),
          { once: true }
        );
      }),
  });
  const profile = await fixture.runtime.resolve({});
  const pending = profile.request({});
  await new Promise(setImmediate);
  assert.equal(fixture.calls.length, 1);
  fixture.retirement.abort(createEnterpriseAudioConfigChangedError());
  await assert.rejects(pending, {
    code: "MANAGED_CONFIG_CHANGED",
    messageKey: "common.managedConfigUnavailable",
  });
});
