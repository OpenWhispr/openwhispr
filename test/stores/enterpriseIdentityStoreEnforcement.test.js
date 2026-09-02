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
