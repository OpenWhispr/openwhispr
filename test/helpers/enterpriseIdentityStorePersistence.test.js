const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const accountId = "account-a";
const workspaceId = "workspace-a";
const authGeneration = 1;

function managedConfig() {
  return {
    workspaceId,
    version: 1,
    generation: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: `workspace:${workspaceId}`,
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers: [],
    localModels: {
      transcription: [{ provider: "whisper", modelId: "base" }],
      reasoning: [],
      version: 4,
      updatedAt: "2026-08-10T00:00:00.000Z",
      updatedByUserId: null,
    },
  };
}

function managedCloudOnlyConfig() {
  return {
    ...managedConfig(),
    providers: [
      {
        provider: "bedrock",
        mode: "managed_required",
        allowManualSetup: false,
        config: {
          roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
          region: "us-east-1",
          allowedModels: ["anthropic.claude-v1"],
          scopeDefaults: {
            dictationCleanup: "anthropic.claude-v1",
            dictationAgent: "anthropic.claude-v1",
            noteFormatting: "anthropic.claude-v1",
            chatIntelligence: "anthropic.claude-v1",
            dictationTranslation: "anthropic.claude-v1",
          },
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
    localModels: null,
  };
}

async function createStoreHarness(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-local-policy-cache-test-",
    mockModules: {
      "/services/EnterpriseIdentityService": `
        export async function getManagedEnterpriseConfig() {
          return globalThis.__managedEnterprisePersistenceResult;
        }
        export function clearManagedEnterpriseIdentity() {}
      `,
    },
  });
  t.after(() => delete globalThis.__managedEnterprisePersistenceResult);
  const loadFreshStore = async () => {
    vite.moduleGraph.invalidateAll();
    return (await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"))
      .useEnterpriseIdentityStore;
  };
  const loadFreshEnterprise = async () => {
    vite.moduleGraph.invalidateAll();
    return vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts");
  };
  return { loadFreshEnterprise, loadFreshStore };
}

function successResult() {
  return {
    success: true,
    accountId,
    workspaceId,
    authGeneration,
    config: managedConfig(),
  };
}

function unavailableResult(enforcementRequired) {
  return {
    success: false,
    accountId,
    workspaceId,
    authGeneration,
    error: "Managed configuration is unavailable",
    ...(typeof enforcementRequired === "boolean" ? { enforcementRequired } : {}),
  };
}

test("identity refresh stores known internal failures as codes and preserves dynamic details", async (t) => {
  const { loadFreshStore } = await createStoreHarness(t);
  const store = await loadFreshStore();
  globalThis.__managedEnterprisePersistenceResult = {
    ...unavailableResult(true),
    code: "MANAGED_CONFIG_INVALID",
    error: "Managed enterprise configuration is malformed",
  };

  await store.getState().refresh(accountId, workspaceId, authGeneration);
  assert.equal(store.getState().error, "MANAGED_CONFIG_INVALID");

  const knownIdentityCodes = [
    "MANAGED_CONFIG_UNAVAILABLE",
    "AUTH_EXPIRED",
    "AUTH_CONTEXT_CHANGED",
    "AUTH_CONTEXT_UNVALIDATED",
    "ENTERPRISE_REQUIRED",
    "MANAGED_WORKSPACE_REQUIRED",
    "SSO_REQUIRED",
    "DIRECTORY_ASSIGNMENT_REQUIRED",
    "PROVIDER_NOT_ALLOWED",
    "PROVIDER_NOT_CONFIGURED",
    "POLICY_UNRESOLVABLE",
  ];
  for (const code of knownIdentityCodes) {
    globalThis.__managedEnterprisePersistenceResult = {
      ...unavailableResult(true),
      code,
      error: `Internal message for ${code}`,
    };
    await store.getState().refresh(accountId, workspaceId, authGeneration, true);
    assert.equal(store.getState().error, code);
  }

  globalThis.__managedEnterprisePersistenceResult = {
    ...unavailableResult(true),
    code: "MANAGED_CONFIG_FAILED",
    error: "The enterprise gateway returned status 502.",
  };
  await store.getState().refresh(accountId, workspaceId, authGeneration, true);
  assert.equal(store.getState().error, "The enterprise gateway returned status 502.");
});

test("a fresh renderer restores sanitized local policy for the same identity", async (t) => {
  const { loadFreshStore } = await createStoreHarness(t);
  globalThis.__managedEnterprisePersistenceResult = successResult();
  const initialStore = await loadFreshStore();
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration);

  globalThis.__managedEnterprisePersistenceResult = unavailableResult(undefined);
  const freshStore = await loadFreshStore();
  const refresh = freshStore.getState().refresh(accountId, workspaceId, authGeneration);

  assert.equal(
    freshStore.getState().failClosed,
    true,
    "the persisted local policy must be enforced while the refresh is still loading"
  );
  assert.deepEqual(freshStore.getState().lastKnownLocalModels, managedConfig().localModels);
  await refresh;

  assert.equal(freshStore.getState().config, null);
  assert.deepEqual(freshStore.getState().lastKnownLocalModels, managedConfig().localModels);
  assert.equal(freshStore.getState().lastKnownLocalModelsKnown, true);
  assert.equal(freshStore.getState().failClosed, true);
});

test("a fresh renderer fails closed for prior managed cloud-only access while loading", async (t) => {
  const { loadFreshEnterprise, loadFreshStore } = await createStoreHarness(t);
  globalThis.__managedEnterprisePersistenceResult = {
    ...successResult(),
    config: managedCloudOnlyConfig(),
  };
  const initialStore = await loadFreshStore();
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration);

  let resolveRefresh;
  globalThis.__managedEnterprisePersistenceResult = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const enterprise = await loadFreshEnterprise();
  const freshStore = enterprise.useEnterpriseIdentityStore;
  const refresh = freshStore.getState().refresh(accountId, workspaceId, authGeneration);

  assert.equal(freshStore.getState().status, "loading");
  assert.equal(freshStore.getState().lastKnownLocalModels, null);
  assert.equal(freshStore.getState().lastKnownLocalModelsKnown, true);
  assert.equal(freshStore.getState().lastKnownManagedInferenceConfigured, true);
  assert.equal(freshStore.getState().failClosed, true);
  assert.equal(enterprise.getManagedLocalModelRuntimeLock("transcription").managed, false);
  assert.equal(enterprise.getManagedLocalModelRuntimeLock("reasoning").managed, false);
  assert.deepEqual(enterprise.getManagedScopeResolution("dictationCleanup", "auto"), {
    kind: "error",
    code: "MANAGED_CONFIG_UNAVAILABLE",
    message: "Managed enterprise access is unavailable. Sign in with company SSO or contact IT.",
  });

  resolveRefresh(unavailableResult(false));
  await refresh;
});

test("a fresh renderer keeps an authoritative unmanaged downgrade unlocked while loading", async (t) => {
  const { loadFreshEnterprise, loadFreshStore } = await createStoreHarness(t);
  globalThis.__managedEnterprisePersistenceResult = {
    ...successResult(),
    config: managedCloudOnlyConfig(),
  };
  const initialStore = await loadFreshStore();
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration);
  globalThis.__managedEnterprisePersistenceResult = unavailableResult(false);
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration, true);

  let resolveRefresh;
  globalThis.__managedEnterprisePersistenceResult = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const enterprise = await loadFreshEnterprise();
  const freshStore = enterprise.useEnterpriseIdentityStore;
  const refresh = freshStore.getState().refresh(accountId, workspaceId, authGeneration);

  assert.equal(freshStore.getState().status, "loading");
  assert.equal(freshStore.getState().lastKnownLocalModels, null);
  assert.equal(freshStore.getState().lastKnownLocalModelsKnown, true);
  assert.equal(freshStore.getState().lastKnownManagedInferenceConfigured, false);
  assert.equal(freshStore.getState().failClosed, false);
  assert.equal(enterprise.getManagedLocalModelRuntimeLock("transcription").managed, false);
  assert.deepEqual(enterprise.getManagedScopeResolution("dictationCleanup", "auto"), {
    kind: "manual",
  });

  resolveRefresh(unavailableResult(false));
  await refresh;
});

test("persisted local policy never crosses account or workspace identity", async (t) => {
  const { loadFreshStore } = await createStoreHarness(t);
  globalThis.__managedEnterprisePersistenceResult = successResult();
  const initialStore = await loadFreshStore();
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration);

  globalThis.__managedEnterprisePersistenceResult = {
    ...unavailableResult(undefined),
    accountId: "account-b",
    workspaceId: "workspace-b",
  };
  const freshStore = await loadFreshStore();
  await freshStore.getState().refresh("account-b", "workspace-b", authGeneration);

  assert.equal(freshStore.getState().lastKnownLocalModels, null);
  assert.equal(freshStore.getState().lastKnownLocalModelsKnown, false);
  assert.equal(freshStore.getState().failClosed, true);
});

test("a new identity with no snapshot is fail-closed while resolution is pending", async (t) => {
  const { loadFreshStore } = await createStoreHarness(t);
  let resolveRequest;
  globalThis.__managedEnterprisePersistenceResult = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const store = await loadFreshStore();
  const refresh = store.getState().refresh(accountId, workspaceId, authGeneration);

  assert.equal(store.getState().status, "loading");
  assert.equal(store.getState().lastKnownLocalModelsKnown, false);
  assert.equal(store.getState().failClosed, true);

  resolveRequest(unavailableResult(false));
  await refresh;
  assert.equal(store.getState().failClosed, false);
  assert.equal(store.getState().lastKnownLocalModelsKnown, true);
});

test("persisted local policy never crosses API origins", async (t) => {
  const { storage } = installBrowserGlobals(t);
  storage.setItem(
    "enterpriseManagedLocalPolicySnapshotsV1",
    JSON.stringify({
      version: 1,
      entries: [
        {
          apiOrigin: "https://staging-api.example.com",
          accountId,
          workspaceId,
          localModels: managedConfig().localModels,
        },
      ],
    })
  );
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-api-origin-policy-cache-test-",
    mockModules: {
      "/services/EnterpriseIdentityService": `
        export async function getManagedEnterpriseConfig() {
          return globalThis.__managedEnterprisePersistenceResult;
        }
        export function clearManagedEnterpriseIdentity() {}
      `,
    },
  });
  t.after(() => delete globalThis.__managedEnterprisePersistenceResult);
  globalThis.__managedEnterprisePersistenceResult = unavailableResult(undefined);
  const store = (await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"))
    .useEnterpriseIdentityStore;

  await store.getState().refresh(accountId, workspaceId, authGeneration);
  assert.equal(store.getState().lastKnownLocalModels, null);
  assert.equal(store.getState().lastKnownLocalModelsKnown, false);
  assert.equal(store.getState().failClosed, true);
});

test("malformed persisted local policy remains unknown and fail-closed", async (t) => {
  const { storage } = installBrowserGlobals(t);
  storage.setItem(
    "enterpriseManagedLocalPolicySnapshotsV1",
    JSON.stringify({ version: 1, entries: [{ accountId, workspaceId, localModels: "invalid" }] })
  );
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-malformed-local-policy-cache-test-",
    mockModules: {
      "/services/EnterpriseIdentityService": `
        export async function getManagedEnterpriseConfig() {
          return globalThis.__managedEnterprisePersistenceResult;
        }
        export function clearManagedEnterpriseIdentity() {}
      `,
    },
  });
  t.after(() => delete globalThis.__managedEnterprisePersistenceResult);
  globalThis.__managedEnterprisePersistenceResult = unavailableResult(undefined);
  const store = (await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"))
    .useEnterpriseIdentityStore;

  await store.getState().refresh(accountId, workspaceId, authGeneration);
  assert.equal(store.getState().lastKnownLocalModels, null);
  assert.equal(store.getState().lastKnownLocalModelsKnown, false);
  assert.equal(store.getState().failClosed, true);
});

test("an ambiguous legacy known-empty snapshot remains unknown and fail-closed", async (t) => {
  const { storage } = installBrowserGlobals(t);
  storage.setItem(
    "enterpriseManagedLocalPolicySnapshotsV1",
    JSON.stringify({
      version: 1,
      entries: [
        {
          apiOrigin: "openwhispr-api:unconfigured",
          accountId,
          workspaceId,
          localModels: null,
        },
      ],
    })
  );
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-ambiguous-legacy-policy-cache-test-",
    mockModules: {
      "/services/EnterpriseIdentityService": `
        export async function getManagedEnterpriseConfig() {
          return globalThis.__managedEnterprisePersistenceResult;
        }
        export function clearManagedEnterpriseIdentity() {}
      `,
    },
  });
  t.after(() => delete globalThis.__managedEnterprisePersistenceResult);
  let resolveRefresh;
  globalThis.__managedEnterprisePersistenceResult = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const store = (await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"))
    .useEnterpriseIdentityStore;
  const refresh = store.getState().refresh(accountId, workspaceId, authGeneration);

  assert.equal(store.getState().lastKnownLocalModelsKnown, false);
  assert.equal(store.getState().lastKnownManagedInferenceConfigured, null);
  assert.equal(store.getState().failClosed, true);

  resolveRefresh(unavailableResult(false));
  await refresh;
});

test("an explicit downgrade persists a known-empty local policy", async (t) => {
  const { loadFreshStore } = await createStoreHarness(t);
  globalThis.__managedEnterprisePersistenceResult = successResult();
  const initialStore = await loadFreshStore();
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration);
  globalThis.__managedEnterprisePersistenceResult = unavailableResult(false);
  await initialStore.getState().refresh(accountId, workspaceId, authGeneration, true);

  globalThis.__managedEnterprisePersistenceResult = unavailableResult(undefined);
  const freshStore = await loadFreshStore();
  const refresh = freshStore.getState().refresh(accountId, workspaceId, authGeneration);
  assert.equal(freshStore.getState().failClosed, false);
  assert.equal(freshStore.getState().lastKnownLocalModelsKnown, true);
  await refresh;

  assert.equal(freshStore.getState().lastKnownLocalModels, null);
  assert.equal(freshStore.getState().lastKnownLocalModelsKnown, true);
  assert.equal(freshStore.getState().failClosed, true);
});
