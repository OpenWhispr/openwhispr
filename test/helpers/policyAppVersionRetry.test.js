const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const managedPolicy = {
  version: 1,
  transcription: { allowedModes: ["openwhispr", "local"], allowedByokProviders: ["openai"] },
  llm: {
    allowedModes: ["openwhispr"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: [],
  },
  features: { agentEnabled: true, webSearchEnabled: true },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: "1.0.0",
};

test("a failed app-version read is retried instead of denying the session", async (t) => {
  let versionRequestCount = 0;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAppVersion: async () => {
          versionRequestCount += 1;
          if (versionRequestCount === 1) throw new Error("IPC unavailable");
          return { version: "1.8.1" };
        },
        getWorkspacePolicy: async () => ({
          success: true,
          status: "network",
          revision: 1,
          accountId: "account-a",
          authGeneration: 1,
          managed: true,
          policy: managedPolicy,
          policyUpdatedAt: "2026-01-01T00:00:00.000Z",
          endpointSupported: true,
        }),
        onWorkspacePolicyChanged() {},
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-app-version-test-",
    mockModules: { "/utils/logger": "export default { error() {} };" },
  });

  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { isPolicyActionAllowed } = await vite.ssrLoadModule("/stores/policyRules.ts");

  await usePolicyStore.getState().fetchPolicy("account-a", 1);
  assert.equal(usePolicyStore.getState().appVersion, null);
  assert.equal(isPolicyActionAllowed(usePolicyStore.getState()), false);

  await usePolicyStore.getState().fetchPolicy("account-a", 1);
  assert.equal(versionRequestCount, 2);
  assert.equal(usePolicyStore.getState().appVersion, "1.8.1");
  assert.equal(isPolicyActionAllowed(usePolicyStore.getState()), true);
});
