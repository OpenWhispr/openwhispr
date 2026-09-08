const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("renderer fails closed when a managed-unresolvable refresh supersedes unmanaged", async (t) => {
  let policyRequestCount = 0;
  let policyChanged;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAppVersion: async () => ({ version: "1.8.1" }),
        getWorkspacePolicy: async () => {
          policyRequestCount += 1;
          if (policyRequestCount === 1) {
            return {
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
          }
          return {
            success: false,
            status: "error",
            code: "POLICY_UNRESOLVABLE",
            error: "Organization policy could not be resolved.",
          };
        },
        onWorkspacePolicyChanged(callback) {
          policyChanged = callback;
        },
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-transition-test-",
    mockModules: { "/utils/logger": "export default { error() {} };" },
  });

  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  await usePolicyStore.getState().fetchPolicy("account-a", 1);
  assert.equal(usePolicyStore.getState().status, "unmanaged");

  policyChanged({
    success: false,
    status: "error",
    revision: 1,
    accountId: "account-a",
    authGeneration: 1,
    code: "POLICY_UNRESOLVABLE",
    error: "Organization policy could not be resolved.",
  });
  await Promise.resolve();
  assert.equal(usePolicyStore.getState().status, "error");

  const retry = usePolicyStore.getState().fetchPolicy("account-a", 1);
  assert.equal(
    usePolicyStore.getState().status,
    "error",
    "a retry for the same account must not remount policy-gated onboarding"
  );
  await retry;
  assert.equal(usePolicyStore.getState().status, "error");
});
