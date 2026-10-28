const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createEnterpriseAudioRuntime,
  createEnterpriseAudioRequestResolver,
  createEnterpriseAudioConfigChangedError,
  enforcesEnterpriseTranscription,
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
  return {
    request,
    identity,
    calls,
    setBinding: (next) => {
      binding = next;
    },
  };
}

const context = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 };

test("cold meeting requests load authoritative membership and enterprise config before routing", async () => {
  const fixture = setup();
  const request = await fixture.request({}, context, "load");
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
  await assert.rejects(fixture.request({}, undefined, "load"), { code: "AUTH_CONTEXT_CHANGED" });
  await assert.rejects(
    fixture.request({}, { ...context, workspaceId: "other-workspace" }, "load"),
    {
      code: "AUTH_CONTEXT_CHANGED",
    }
  );
  assert.equal(fixture.calls.includes("config"), false);
});

test("personal users without workspaces and signed-out guests retain personal routing", async () => {
  const fixture = setup({ getWorkspaces: async () => [] });
  assert.equal(await fixture.request({}, undefined, "load"), null);
  fixture.identity.signedIn = false;
  fixture.identity.accountId = null;
  assert.equal(await fixture.request({}, undefined, "load"), null);
});

test("identity changes during workspace lookup cannot install a stale binding", async () => {
  let finish;
  const fixture = setup({
    getWorkspaces: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = fixture.request({}, context, "load");
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
  const pending = fixture.request({}, context, "load");
  await new Promise(setImmediate);
  revision++;
  finish([{ id: "workspace-a" }]);
  await assert.rejects(pending, { code: "AUTH_CONTEXT_CHANGED" });
  assert.deepEqual(fixture.calls, []);
});

const enforcedBinding = {
  success: true,
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 1,
  generation: 3,
  config: {
    generation: 3,
    providers: [
      {
        provider: "azure",
        mode: "managed_required",
        allowManualSetup: false,
        config: { transcription: { defaultDeployment: "speech" } },
      },
    ],
  },
};

test("meetings without a managed context take the personal route without any lookup", async () => {
  const lookups = [];
  const fixture = setup({
    getAuthHeaders: async () => {
      lookups.push("auth");
      return {};
    },
    getWorkspaces: async () => {
      lookups.push("membership");
      throw new Error("offline");
    },
  });
  // Signed in, a member of workspaces, with or without an active workspace context.
  assert.equal(await fixture.request({}, undefined, "personal"), null);
  assert.equal(await fixture.request({}, context, "personal"), null);
  fixture.setBinding({
    ...enforcedBinding,
    config: {
      ...enforcedBinding.config,
      providers: [
        { ...enforcedBinding.config.providers[0], mode: "managed_default", allowManualSetup: true },
      ],
    },
  });
  assert.equal(await fixture.request({}, context, "personal"), null);
  assert.deepEqual(lookups, []);
  assert.deepEqual(fixture.calls, []);
});

const realtimeEnforcedBinding = {
  ...enforcedBinding,
  config: {
    ...enforcedBinding.config,
    providers: [
      {
        ...enforcedBinding.config.providers[0],
        config: {
          transcription: { defaultDeployment: "speech" },
          realtime: { defaultDeployment: "rt" },
        },
      },
    ],
  },
};

test("a known enforced realtime binding still routes and fails closed", async () => {
  const fixture = setup();
  fixture.setBinding(realtimeEnforcedBinding);
  const request = await fixture.request({}, context, "personal");
  assert.equal(request.workspaceId, "workspace-a");
  assert.equal((await fixture.request({}, undefined, "personal")).workspaceId, "workspace-a");
  await assert.rejects(
    fixture.request({}, { ...context, workspaceId: "workspace-b" }, "personal"),
    { code: "AUTH_CONTEXT_CHANGED" }
  );
  // An eviction that reports enforced realtime keeps failing closed without a config, as
  // does one from a build that predates per-operation reports.
  for (const enforcedAudioOperations of [["batch", "realtime"], undefined]) {
    fixture.setBinding({
      ...enforcedBinding,
      config: null,
      enforcedScopes: ["transcription"],
      enforcedAudioOperations,
    });
    assert.equal((await fixture.request({}, context, "personal")).workspaceId, "workspace-a");
  }
  assert.deepEqual(fixture.calls, []);
});

test("a required batch-only binding leaves personal meetings local, even once evicted", async () => {
  const lookups = [];
  const fixture = setup({
    getAuthHeaders: async () => {
      lookups.push("auth");
      return {};
    },
  });
  for (const binding of [
    enforcedBinding,
    {
      ...enforcedBinding,
      config: null,
      enforcedScopes: ["transcription"],
      enforcedAudioOperations: ["batch"],
    },
  ]) {
    fixture.setBinding(binding);
    assert.equal(await fixture.request({}, context, "personal"), null);
    assert.equal(enforcesEnterpriseTranscription(binding, "batch"), true);
  }
  assert.deepEqual(lookups, []);
});

test("only enforced records with an audio section require enterprise transcription", () => {
  assert.equal(enforcesEnterpriseTranscription(null), false);
  assert.equal(enforcesEnterpriseTranscription(enforcedBinding), false);
  assert.equal(enforcesEnterpriseTranscription(enforcedBinding, "batch"), true);
  assert.equal(enforcesEnterpriseTranscription(realtimeEnforcedBinding), true);
  assert.equal(enforcesEnterpriseTranscription({ enforcedScopes: ["transcription"] }), true);
  assert.equal(
    enforcesEnterpriseTranscription({
      enforcedScopes: ["transcription"],
      enforcedAudioOperations: ["batch"],
    }),
    false
  );
  assert.equal(enforcesEnterpriseTranscription({ enforcedScopes: ["dictationCleanup"] }), false);
  const [record] = realtimeEnforcedBinding.config.providers;
  for (const changed of [
    { ...record, mode: "disabled" },
    { ...record, mode: "managed_default", allowManualSetup: true },
    { ...record, config: { scopeDefaults: { dictationCleanup: "chat" } } },
  ])
    assert.equal(enforcesEnterpriseTranscription({ config: { providers: [changed] } }), false);
});

function audioRuntime({
  provider = "openai-compatible",
  tokenProvider = async () => "token",
  request,
  network,
  systemFetch,
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
      network,
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
    systemFetch,
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

test("Azure batch without transport-only network settings stays on Electron's network stack", async () => {
  for (const network of [undefined, { sessionMaxMs: 600000 }, { proxy: { mode: "system" } }]) {
    const sent = [];
    const fixture = audioRuntime({
      provider: "azure",
      network,
      systemFetch: async (url, init) => {
        sent.push({ url, init });
        return new Response('{"text":"transcript"}');
      },
    });
    const profile = await fixture.runtime.resolve({});
    assert.equal(profile.systemNetwork, true);
    const response = await profile.request({ method: "POST", headers: { "x-test": "1" } });
    assert.equal(await response.text(), '{"text":"transcript"}');
    assert.equal(fixture.calls.length, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, profile.endpoint);
    assert.equal(sent[0].init.headers.Authorization, "Bearer token");
    assert.equal(sent[0].init.headers["x-test"], "1");
    assert.ok(sent[0].init.signal instanceof AbortSignal);
  }
});

test("network settings Electron cannot express keep the enterprise transport", async () => {
  for (const [provider, network] of [
    ["azure", { proxy: { mode: "fixed", url: "http://proxy.test:8080/" } }],
    ["azure", { proxy: { mode: "system", mandatory: true } }],
    ["azure", { httpTimeoutMs: 300000 }],
    ["openai-compatible", undefined],
  ]) {
    const sent = [];
    const fixture = audioRuntime({
      provider,
      network,
      systemFetch: async (...args) => sent.push(args),
    });
    const profile = await fixture.runtime.resolve({});
    assert.equal(profile.systemNetwork, false);
    await profile.request({});
    assert.equal(fixture.calls.length, 1);
    assert.equal(sent.length, 0);
  }
});
