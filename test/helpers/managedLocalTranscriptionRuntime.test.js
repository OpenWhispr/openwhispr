const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("managed local transcription runtime classifies session readiness and binding state", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-local-runtime-test-",
  });
  const { resolveManagedLocalTranscriptionRuntime } = await vite.ssrLoadModule(
    "/helpers/managedLocalTranscriptionRuntime.ts"
  );
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { rememberManagedLocalModelBinding } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModels.ts"
  );
  const identity = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 7,
    configGeneration: 12,
  };
  const configuredState = {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    authGeneration: identity.authGeneration,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    config: {
      workspaceId: identity.workspaceId,
      version: 12,
      generation: identity.configGeneration,
      identity: {},
      providers: [],
      localModels: { selections: [{ provider: "whisper", model: "base" }] },
    },
  };
  const signedIn = { isSignedIn: true };

  const rows = [
    {
      name: "guest remains unmanaged",
      state: {
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        status: "idle",
        config: null,
      },
      settings: { isSignedIn: false },
      want: { kind: "unmanaged" },
    },
    {
      name: "signed-in cold identity fails closed even while identity fields are empty",
      state: {
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        status: "idle",
        config: null,
      },
      want: { kind: "error", code: "MANAGED_CONFIG_UNAVAILABLE" },
    },
    {
      name: "authoritative unmanaged remains unmanaged",
      state: {
        ...configuredState,
        status: "error",
        verdict: "unmanaged",
        failClosed: false,
        config: null,
      },
      want: { kind: "unmanaged" },
    },
    {
      name: "configured local policy without dictation remains unmanaged",
      state: {
        ...configuredState,
        config: {
          ...configuredState.config,
          localModels: { selections: [{ provider: "qwen", model: "qwen3.5-9b-q4_k_m" }] },
        },
      },
      want: { kind: "unmanaged" },
    },
    {
      name: "loading unknown identity fails closed",
      state: { ...configuredState, status: "loading", verdict: "unknown", config: null },
      want: { kind: "error", code: "MANAGED_CONFIG_UNAVAILABLE" },
    },
    {
      name: "workspace transition fails closed before its config resolves",
      state: {
        ...configuredState,
        workspaceId: "workspace-b",
        status: "loading",
        verdict: "unknown",
        config: null,
      },
      want: { kind: "error", code: "MANAGED_CONFIG_UNAVAILABLE" },
    },
    {
      name: "token transition fails closed before its config resolves",
      state: {
        ...configuredState,
        authGeneration: 8,
        status: "loading",
        verdict: "unknown",
        config: null,
      },
      want: { kind: "error", code: "MANAGED_CONFIG_UNAVAILABLE" },
    },
    {
      name: "unknown transient error fails closed",
      state: {
        ...configuredState,
        status: "error",
        verdict: "unknown",
        failClosed: true,
        config: null,
      },
      want: { kind: "error", code: "MANAGED_CONFIG_UNAVAILABLE" },
    },
  ];

  for (const row of rows) {
    useEnterpriseIdentityStore.setState(row.state);
    assert.deepEqual(
      resolveManagedLocalTranscriptionRuntime(row.settings ?? signedIn),
      row.want,
      row.name
    );
  }

  useEnterpriseIdentityStore.setState(configuredState);

  assert.deepEqual(resolveManagedLocalTranscriptionRuntime(signedIn), {
    kind: "error",
    code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
  });
  rememberManagedLocalModelBinding({
    ...identity,
    category: "dictation",
    provider: "whisper",
    model: "base",
  });
  assert.deepEqual(resolveManagedLocalTranscriptionRuntime(signedIn), {
    kind: "managed",
    provider: "whisper",
    model: "base",
    identity,
  });

  for (const staleBinding of [
    { ...identity, configGeneration: 13 },
    { ...identity, authGeneration: 8 },
  ]) {
    useEnterpriseIdentityStore.setState({
      ...configuredState,
      authGeneration: staleBinding.authGeneration,
      config: { ...configuredState.config, generation: staleBinding.configGeneration },
    });
    assert.deepEqual(resolveManagedLocalTranscriptionRuntime(signedIn), {
      kind: "error",
      code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
    });
  }

  useEnterpriseIdentityStore.setState(configuredState);
  const { rememberManagedPendingLocalModel, consumeManagedPendingLocalModel } =
    await vite.ssrLoadModule("/components/onboarding/pendingLocalModels.ts");
  for (const transferState of ["downloading", "missing"]) {
    const pending = { ...identity, provider: "whisper", modelId: "base", transferState };
    rememberManagedPendingLocalModel("dictation", pending);
    assert.deepEqual(
      resolveManagedLocalTranscriptionRuntime(signedIn),
      {
        kind: "error",
        code: "MANAGED_LOCAL_MODEL_UNAVAILABLE",
      },
      transferState
    );
    assert.deepEqual(consumeManagedPendingLocalModel("dictation", pending), pending);
  }
  assert.deepEqual(resolveManagedLocalTranscriptionRuntime(signedIn), {
    kind: "managed",
    provider: "whisper",
    model: "base",
    identity,
  });
});
