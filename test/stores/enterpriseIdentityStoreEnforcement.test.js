const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];
const identity = {
  issuer: "https://api.example.com/enterprise-identity",
  jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
  subject: "workspace:workspace-a",
  audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
};
const bedrockRequired = {
  workspaceId: "workspace-a",
  version: 1,
  generation: 1,
  identity,
  providers: [
    {
      provider: "bedrock",
      mode: "managed_required",
      allowManualSetup: false,
      config: {
        roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
        region: "us-east-1",
        allowedModels: ["m"],
        scopeDefaults: Object.fromEntries(SCOPES.map((s) => [s, "m"])),
      },
      version: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  ],
};
const azureSttRequired = {
  workspaceId: "workspace-a",
  version: 1,
  generation: 1,
  identity,
  providers: [
    {
      provider: "azure",
      mode: "managed_required",
      allowManualSetup: false,
      config: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        clientId: "22222222-2222-4222-8222-222222222222",
        endpoint: "https://example.openai.azure.com",
        apiVersion: "preview",
        transcription: {
          allowedDeployments: ["gpt-4o-transcribe"],
          defaultDeployment: "gpt-4o-transcribe",
        },
      },
      version: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  ],
};
const policy = {
  version: 1,
  transcription: {
    allowedModes: ["enterprise", "local"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["azure"],
  },
  llm: {
    allowedModes: ["enterprise", "local"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["bedrock"],
  },
  features: { agentEnabled: true, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

async function boot(t, { electronAPI = {}, initialStorage = {} } = {}) {
  installBrowserGlobals(t, { initialStorage, window: { electronAPI } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-identity-enforcement-" });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy });
  return { useEnterpriseIdentityStore, getManagedScopeResolution };
}

test("an LLM-only enforced workspace never fails transcription closed on a config outage", async (t) => {
  let call = 0;
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await boot(t, {
    electronAPI: {
      getManagedEnterpriseConfig: async (accountId, workspaceId, authGeneration) => {
        call += 1;
        if (call === 1)
          return {
            success: true,
            status: "network",
            accountId,
            workspaceId,
            authGeneration,
            config: bedrockRequired,
          };
        return {
          success: false,
          status: "error",
          accountId,
          workspaceId,
          authGeneration,
          code: "AUTH_EXPIRED",
          error: "expired",
          enforcementRequired: true,
          enforcedScopes: SCOPES,
        };
      },
    },
  });
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  assert.equal(getManagedScopeResolution("transcription", "auto").kind, "manual");
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1, true);
  assert.equal(useEnterpriseIdentityStore.getState().status, "error");
  assert.equal(getManagedScopeResolution("transcription", "auto").kind, "manual");
  assert.equal(
    getManagedScopeResolution("dictationCleanup", "auto").code,
    "MANAGED_CONFIG_UNAVAILABLE"
  );
});

test("an STT-only enforced workspace fails only transcription closed", async (t) => {
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await boot(t);
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "error",
    config: null,
    error: "offline",
    managedScopes: ["transcription"],
    enforcedScopes: ["transcription"],
  });
  assert.equal(
    getManagedScopeResolution("transcription", "auto").code,
    "MANAGED_CONFIG_UNAVAILABLE"
  );
  assert.equal(getManagedScopeResolution("dictationCleanup", "auto").kind, "manual");
});

test("the first fetch holds only scopes the last-known config enforced", async (t) => {
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await boot(t, {
    initialStorage: {
      "managedEnterpriseScopes:account-a:workspace-a": JSON.stringify({
        managed: ["transcription"],
        enforced: ["transcription"],
      }),
    },
    electronAPI: { getManagedEnterpriseConfig: () => new Promise(() => {}) },
  });
  void useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  assert.equal(useEnterpriseIdentityStore.getState().status, "loading");
  assert.equal(getManagedScopeResolution("transcription", "auto").code, "MANAGED_CONFIG_LOADING");
  assert.equal(getManagedScopeResolution("dictationCleanup", "auto").kind, "manual");
});

test("a successful fetch persists the scope summary for the next cold start", async (t) => {
  const { useEnterpriseIdentityStore } = await boot(t, {
    electronAPI: {
      getManagedEnterpriseConfig: async (a, w, g) => ({
        success: true,
        status: "network",
        accountId: a,
        workspaceId: w,
        authGeneration: g,
        config: azureSttRequired,
      }),
    },
  });
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  assert.deepEqual(
    JSON.parse(globalThis.localStorage.getItem("managedEnterpriseScopes:account-a:workspace-a")),
    { managed: ["transcription"], enforced: ["transcription"] }
  );
  assert.deepEqual(useEnterpriseIdentityStore.getState().enforcedScopes, []);
  assert.deepEqual(useEnterpriseIdentityStore.getState().managedScopes, ["transcription"]);
});

test("a retry after an error holds the scopes carried in memory even with no persisted hint", async (t) => {
  let call = 0;
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await boot(t, {
    electronAPI: {
      getManagedEnterpriseConfig: (accountId, workspaceId, authGeneration) => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            success: false,
            status: "error",
            accountId,
            workspaceId,
            authGeneration,
            code: "AUTH_EXPIRED",
            error: "expired",
            enforcementRequired: true,
            enforcedScopes: SCOPES,
          });
        }
        // The retry: never resolves, so the store stays in "loading" for the
        // duration of the assertions below.
        return new Promise(() => {});
      },
    },
  });

  // First fetch fails; nothing has ever been persisted for this identity.
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  assert.equal(useEnterpriseIdentityStore.getState().status, "error");
  assert.deepEqual(useEnterpriseIdentityStore.getState().enforcedScopes, SCOPES);
  assert.equal(
    globalThis.localStorage.getItem("managedEnterpriseScopes:account-a:workspace-a"),
    null
  );

  // A retry for the same identity carries the in-memory enforcedScopes
  // forward into the "loading" window — it must not fail open just because
  // there is no persisted hint to fall back on.
  void useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  assert.equal(useEnterpriseIdentityStore.getState().status, "loading");
  assert.equal(useEnterpriseIdentityStore.getState().config, null);
  assert.equal(
    getManagedScopeResolution("dictationCleanup", "auto").code,
    "MANAGED_CONFIG_LOADING"
  );
  assert.equal(getManagedScopeResolution("transcription", "auto").kind, "manual");
});

test("the transcription opt-out is independent of the LLM setup mode", async (t) => {
  installBrowserGlobals(t, { initialStorage: { enterpriseSetupMode: "manual" } });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-stt-setup-mode-" });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { getManagedTranscriptionResolution } = await vite.ssrLoadModule(
    "/services/managedTranscription.ts"
  );
  usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy });
  const sttDefault = structuredClone(azureSttRequired);
  sttDefault.providers[0].mode = "managed_default";
  sttDefault.providers[0].allowManualSetup = true;
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: sttDefault,
    error: null,
    managedScopes: ["transcription"],
    enforcedScopes: [],
  });
  assert.equal(useSettingsStore.getState().enterpriseSetupMode, "manual");
  assert.equal(useSettingsStore.getState().enterpriseTranscriptionSetupMode, "auto");
  assert.equal(getManagedTranscriptionResolution()?.kind, "managed");
  useSettingsStore.getState().setEnterpriseTranscriptionSetupMode("manual");
  assert.equal(getManagedTranscriptionResolution(), undefined);
  assert.equal(useSettingsStore.getState().enterpriseSetupMode, "manual");
});

test("a cold start (status idle, no config yet) holds only the scopes a persisted hint enforces", async (t) => {
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await boot(t, {
    initialStorage: {
      "managedEnterpriseScopes:account-a:workspace-a": JSON.stringify({
        managed: ["transcription"],
        enforced: ["transcription"],
      }),
    },
  });
  // The window between app start (or a workspace switch) and the first
  // refresh() call resolving: the store's initial status is "idle", not
  // "loading", but the identity is already known (e.g. restored from a
  // prior session) and no config has arrived yet.
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
  });
  assert.equal(useEnterpriseIdentityStore.getState().status, "idle");
  assert.equal(useEnterpriseIdentityStore.getState().config, null);
  assert.equal(getManagedScopeResolution("transcription", "auto").code, "MANAGED_CONFIG_LOADING");
  assert.equal(getManagedScopeResolution("dictationCleanup", "auto").kind, "manual");
});

test("clear() never strands a signed-out user under a stale persisted hint", async (t) => {
  const { useEnterpriseIdentityStore, getManagedScopeResolution } = await boot(t, {
    initialStorage: {
      "managedEnterpriseScopes:account-a:workspace-a": JSON.stringify({
        managed: ["transcription"],
        enforced: ["transcription"],
      }),
    },
    electronAPI: {
      getManagedEnterpriseConfig: async (a, w, g) => ({
        success: true,
        status: "network",
        accountId: a,
        workspaceId: w,
        authGeneration: g,
        config: azureSttRequired,
      }),
    },
  });
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  assert.equal(
    getManagedScopeResolution("transcription", "auto").kind,
    "managed",
    "sanity check: the workspace really does enforce transcription while signed in"
  );

  useEnterpriseIdentityStore.getState().clear();

  const state = useEnterpriseIdentityStore.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.accountId, null);
  assert.equal(state.workspaceId, null);
  assert.equal(state.config, null);
  // No accountId/workspaceId means the persisted hint for account-a/workspace-a
  // can't be looked up, so a signed-out user is never held for someone else's
  // (or their own former) organization's enforcement.
  assert.equal(getManagedScopeResolution("transcription", "auto").kind, "manual");
  assert.equal(getManagedScopeResolution("dictationCleanup", "auto").kind, "manual");
});
