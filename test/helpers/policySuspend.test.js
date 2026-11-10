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

test("a rotated token keeps the account's settled verdict until the new answer lands", async (t) => {
  const responses = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAppVersion: async () => ({ version: "1.8.1" }),
        getWorkspacePolicy: () =>
          new Promise((resolve) => {
            responses.push(resolve);
          }),
        onWorkspacePolicyChanged() {},
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-rotation-test-",
    mockModules: { "/utils/logger": "export default { error() {} };" },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const answer = (accountId, authGeneration, revision, policy) => ({
    success: true,
    status: "network",
    revision,
    accountId,
    authGeneration,
    managed: true,
    policy,
    policyUpdatedAt: null,
    endpointSupported: true,
  });
  const policy = (minAppVersion) => ({ version: 1, minAppVersion });

  const first = usePolicyStore.getState().fetchPolicy("account-a", 1);
  responses.shift()(answer("account-a", 1, 9, policy(null)));
  await first;
  const settled = usePolicyStore.getState().policy;

  const rotated = usePolicyStore.getState().fetchPolicy("account-a", 2);
  assert.equal(usePolicyStore.getState().status, "managed");
  assert.equal(usePolicyStore.getState().policy, settled);
  assert.equal(usePolicyStore.getState().authGeneration, 2);

  // The new credential's first answer may carry a lower revision than the old one's.
  responses.shift()(answer("account-a", 2, 1, policy("1.0.0")));
  await rotated;
  assert.equal(usePolicyStore.getState().policy.minAppVersion, "1.0.0");
  assert.equal(usePolicyStore.getState().revision, 1);

  // One account's verdict never authorizes another.
  const switched = usePolicyStore.getState().fetchPolicy("account-b", 3);
  assert.equal(usePolicyStore.getState().status, "loading");
  assert.equal(usePolicyStore.getState().policy, null);
  assert.equal(usePolicyStore.getState().accountId, "account-b");
  responses.shift()(answer("account-b", 3, 1, policy(null)));
  await switched;
});
