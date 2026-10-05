const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("a cleared policy is not clobbered by a stale failure write", async (t) => {
  let resolveVersion;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAppVersion: () =>
          new Promise((resolve) => {
            resolveVersion = resolve;
          }),
        getWorkspacePolicy: async () => {
          throw new Error("network down");
        },
        onWorkspacePolicyChanged() {},
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-stale-write-test-",
    mockModules: { "/utils/logger": "export default { error() {} };" },
  });

  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");

  const fetchPromise = usePolicyStore.getState().fetchPolicy("account-a", 1);
  // Let the fetch reject and the failure path park on the pending app-version read.
  await new Promise((resolve) => setImmediate(resolve));
  usePolicyStore.getState().clearPolicy();
  resolveVersion({ version: "1.8.1" });
  await fetchPromise;

  assert.equal(usePolicyStore.getState().status, "idle");
  assert.equal(usePolicyStore.getState().accountId, null);
});
