const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const workspaceId = "11111111-1111-4111-8111-111111111111";

test("a new identity fails closed until its exact config arrives", async (t) => {
  let resolveRequest;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getManagedEnterpriseConfig: () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
        clearManagedEnterpriseIdentity: async () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-session-test-",
  });
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  const refresh = useEnterpriseIdentityStore.getState().refresh("account-a", workspaceId, 7);
  const loading = useEnterpriseIdentityStore.getState();
  assert.equal(loading.accountId, "account-a");
  assert.equal(loading.workspaceId, workspaceId);
  assert.equal(loading.authGeneration, 7);
  assert.equal(loading.status, "loading");
  assert.equal(loading.failClosed, true);
  assert.equal(loading.verdict, "unknown");
  resolveRequest({
    success: true,
    accountId: "account-a",
    workspaceId,
    authGeneration: 7,
    config: null,
    enforcementRequired: false,
  });
  await refresh;
  assert.equal(useEnterpriseIdentityStore.getState().status, "error");
  assert.equal(useEnterpriseIdentityStore.getState().failClosed, false);
  assert.equal(useEnterpriseIdentityStore.getState().verdict, "unmanaged");
});

test("only an exact config or explicit unmanaged result settles an identity", async (t) => {
  const responses = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getManagedEnterpriseConfig: () => Promise.resolve(responses.shift()),
        clearManagedEnterpriseIdentity: async () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-settlement-test-",
  });
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const config = { workspaceId, generation: 1, providers: [] };
  responses.push({
    success: true,
    accountId: "account-a",
    workspaceId,
    authGeneration: 7,
    config,
  });
  await useEnterpriseIdentityStore.getState().refresh("account-a", workspaceId, 7);
  assert.equal(useEnterpriseIdentityStore.getState().status, "ready");
  assert.equal(useEnterpriseIdentityStore.getState().verdict, "configured");
  assert.equal(useEnterpriseIdentityStore.getState().failClosed, false);

  responses.push({
    success: true,
    accountId: "account-a",
    workspaceId,
    authGeneration: 8,
    config: null,
  });
  await useEnterpriseIdentityStore.getState().refresh("account-a", workspaceId, 8);
  assert.equal(useEnterpriseIdentityStore.getState().status, "error");
  assert.equal(useEnterpriseIdentityStore.getState().verdict, "unknown");
  assert.equal(useEnterpriseIdentityStore.getState().failClosed, true);
});

test("an unknown IPC failure remains fail-closed and unready", async (t) => {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getManagedEnterpriseConfig: async () => ({
          success: false,
          accountId: "account-a",
          workspaceId,
          authGeneration: 7,
          error: "Service unavailable",
        }),
        clearManagedEnterpriseIdentity: async () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-ipc-failure-test-",
  });
  const { shouldWaitForEnterpriseReadiness, useEnterpriseIdentityStore } =
    await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts");

  await useEnterpriseIdentityStore.getState().refresh("account-a", workspaceId, 7);
  const state = useEnterpriseIdentityStore.getState();
  assert.equal(state.status, "error");
  assert.equal(state.verdict, "unknown");
  assert.equal(state.failClosed, true);
  assert.equal(shouldWaitForEnterpriseReadiness(true, state.status, state.verdict), true);
});

test("stale workspace replies and clear cannot restore a prior session", async (t) => {
  const pending = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getManagedEnterpriseConfig: (...args) =>
          new Promise((resolve) => pending.push({ args, resolve })),
        clearManagedEnterpriseIdentity: async () => {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-stale-test-",
  });
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  void useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 7);
  void useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-b", 7);
  pending[0].resolve({ success: true, accountId: "account-a", workspaceId: "workspace-a", authGeneration: 7, config: {} });
  await Promise.resolve();
  assert.equal(useEnterpriseIdentityStore.getState().workspaceId, "workspace-b");
  useEnterpriseIdentityStore.getState().clear();
  pending[1].resolve({ success: true, accountId: "account-a", workspaceId: "workspace-b", authGeneration: 7, config: {} });
  await Promise.resolve();
  assert.equal(useEnterpriseIdentityStore.getState().status, "idle");
  assert.equal(useEnterpriseIdentityStore.getState().config, null);
  assert.equal(useEnterpriseIdentityStore.getState().verdict, "unknown");
});
