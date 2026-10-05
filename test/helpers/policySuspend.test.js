const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("suspendPolicy fails closed while account reconciliation runs", async (t) => {
  const policyResponses = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAppVersion: async () => ({ version: "1.8.1" }),
        getWorkspacePolicy: () =>
          new Promise((resolve) => {
            policyResponses.push(resolve);
          }),
        onWorkspacePolicyChanged() {},
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-suspend-test-",
    mockModules: { "/utils/logger": "export default { error() {} };" },
  });

  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { isPolicyActionAllowed } = await vite.ssrLoadModule("/stores/policyRules.ts");
  const unmanagedResponse = {
    success: true,
    status: "network",
    revision: 1,
    accountId: "account-a",
    authGeneration: 1,
    managed: false,
    policy: null,
    policyUpdatedAt: null,
    endpointSupported: true,
  };

  const firstFetch = usePolicyStore.getState().fetchPolicy("account-a", 1);
  policyResponses.shift()(unmanagedResponse);
  await firstFetch;
  assert.equal(usePolicyStore.getState().status, "unmanaged");
  assert.equal(isPolicyActionAllowed(usePolicyStore.getState()), true);

  // Account reconciliation begins while a refresh is mid-flight.
  const staleFetch = usePolicyStore.getState().fetchPolicy("account-a", 1);
  usePolicyStore.getState().suspendPolicy();

  const suspended = usePolicyStore.getState();
  assert.equal(suspended.status, "loading");
  assert.equal(suspended.accountId, null);
  assert.equal(isPolicyActionAllowed(suspended), false, "suspension must fail closed");

  // The superseded refresh must not resurrect the old account's policy state.
  policyResponses.shift()(unmanagedResponse);
  await staleFetch;
  assert.equal(usePolicyStore.getState().status, "loading");
  assert.equal(usePolicyStore.getState().accountId, null);
});
