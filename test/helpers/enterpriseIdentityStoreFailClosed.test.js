const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

function managedConfig() {
  return {
    workspaceId: "workspace-a",
    version: 1,
    generation: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: "workspace:workspace-a",
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers: [
      {
        provider: "bedrock",
        mode: "managed_required",
        allowManualSetup: false,
        config: {
          roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
          region: "us-east-1",
          allowedModels: ["anthropic.claude-v1"],
          scopeDefaults: { dictationCleanup: "anthropic.claude-v1" },
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
    localModels: {
      transcription: [{ provider: "whisper", modelId: "base" }],
      reasoning: [],
      version: 4,
      updatedAt: "2026-08-10T00:00:00.000Z",
      updatedByUserId: null,
    },
  };
}

test("fail-closed refresh retains only the identity-scoped local model snapshot", async (t) => {
  installBrowserGlobals(t);
  globalThis.__managedEnterpriseResult = {
    success: true,
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    config: managedConfig(),
  };
  t.after(() => delete globalThis.__managedEnterpriseResult);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-fail-closed-test-",
    mockModules: {
      "/services/EnterpriseIdentityService": `
        export async function getManagedEnterpriseConfig() {
          return globalThis.__managedEnterpriseResult;
        }
        export function clearManagedEnterpriseIdentity() {}
      `,
    },
  });
  const enterprise = await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts");
  const store = enterprise.useEnterpriseIdentityStore;

  await store.getState().refresh("account-a", "workspace-a", 1);
  assert.deepEqual(store.getState().lastKnownLocalModels, managedConfig().localModels);
  assert.equal(store.getState().lastKnownLocalModelsKnown, true);

  globalThis.__managedEnterpriseResult = {
    success: false,
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    error: "Company SSO is unavailable",
    enforcementRequired: true,
  };
  await store.getState().refresh("account-a", "workspace-a", 1, true);

  assert.equal(store.getState().config, null, "stale managed-cloud routes must stay evicted");
  assert.deepEqual(store.getState().lastKnownLocalModels, managedConfig().localModels);
  assert.equal(store.getState().lastKnownLocalModelsKnown, true);
  assert.equal(store.getState().failClosed, true);
  assert.equal(
    enterprise.getManagedScopeResolution("dictationCleanup", "auto").kind,
    "error",
    "cloud inference must fail closed rather than reuse the retained local snapshot"
  );
});
