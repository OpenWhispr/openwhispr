const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("managed policy gates preserve the user's raw preferences", async (t) => {
  const policy = {
    version: 1,
    transcription: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
    llm: {
      allowedModes: ["openwhispr"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
    features: { agentEnabled: false, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: 7,
      localHistoryMode: "always_off",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  };
  installBrowserGlobals(t, {
    initialStorage: {
      transcriptionMode: "local",
      useLocalWhisper: "true",
      cloudBackupEnabled: "true",
      dataRetentionEnabled: "true",
      audioRetentionDays: "90",
    },
    window: {
      electronAPI: {
        getAppVersion: async () => ({ version: "1.8.1" }),
        getWorkspacePolicy: async () => ({
          success: true,
          status: "network",
          revision: 1,
          accountId: "account-a",
          authGeneration: 1,
          managed: true,
          policy,
          policyUpdatedAt: "2026-08-05T00:00:00.000Z",
          endpointSupported: true,
        }),
        onWorkspacePolicyChanged() {},
      },
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-prefs-test-",
  });

  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { isCloudBackupAllowed, lockedLocalHistoryValue } =
    await vite.ssrLoadModule("/stores/policyRules.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const before = useSettingsStore.getState();
  assert.equal(before.transcriptionMode, "local");
  assert.equal(before.cloudBackupEnabled, true);

  await usePolicyStore.getState().fetchPolicy("account-a", 1);

  const after = useSettingsStore.getState();
  assert.equal(after.transcriptionMode, "local");
  assert.equal(after.cloudBackupEnabled, true);
  assert.equal(after.dataRetentionEnabled, true);
  assert.equal(after.audioRetentionDays, 90);
  assert.equal(isCloudBackupAllowed(usePolicyStore.getState()), false);
  assert.equal(lockedLocalHistoryValue(usePolicyStore.getState()), false);
});
