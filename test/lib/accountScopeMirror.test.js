const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The dictation window cannot resolve a session (sandboxed, web security
// enforced), so the managed identity there is hydrated from the main
// process's validated account scope instead. These tests drive that mirror
// with the same probe the live verification uses: isManagedTranscriptionActive.
const azureSttRequired = {
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
  llm: { allowedModes: ["openwhispr"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: true, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};

function windowEvents() {
  const listeners = new Map();
  return {
    add: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    remove: (type, listener) =>
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      ),
    dispatch: (type, event) => (listeners.get(type) ?? []).forEach((listener) => listener(event)),
    count: (type) => (listeners.get(type) ?? []).length,
  };
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function boot(t, { scope = null, activeWorkspaceId = null, readScope } = {}) {
  // Registered before installBrowserGlobals so the mirror detaches while `window` still exists.
  let stop = () => {};
  t.after(() => stop());
  const events = windowEvents();
  const calls = { policy: [], config: [] };
  let onScopeChanged = null;
  const electronAPI = {
    getAppVersion: async () => ({ version: "1.10.0" }),
    getActiveAccountScope: readScope ?? (async () => scope),
    onActiveAccountScopeChanged: (callback) => {
      onScopeChanged = callback;
      return () => {
        onScopeChanged = null;
      };
    },
    getWorkspacePolicy: async (accountId, authGeneration) => {
      calls.policy.push([accountId, authGeneration]);
      return {
        success: true,
        revision: calls.policy.length,
        accountId,
        authGeneration,
        managed: true,
        policy,
      };
    },
    getManagedEnterpriseConfig: async (accountId, workspaceId, authGeneration) => {
      calls.config.push([accountId, workspaceId, authGeneration]);
      return {
        success: true,
        status: "network",
        accountId,
        workspaceId,
        authGeneration,
        config: azureSttRequired,
      };
    },
    clearManagedEnterpriseIdentity: async () => {},
  };
  const { storage } = installBrowserGlobals(t, {
    initialStorage: activeWorkspaceId ? { activeWorkspaceId } : {},
    window: { electronAPI, addEventListener: events.add, removeEventListener: events.remove },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-account-scope-mirror-" });
  const { mirrorActiveAccountScope } = await vite.ssrLoadModule("/lib/accountScopeMirror.ts");
  const managed = await vite.ssrLoadModule("/services/managedTranscription.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  stop = mirrorActiveAccountScope();
  return {
    managed,
    usePolicyStore,
    useEnterpriseIdentityStore,
    calls,
    events,
    stop,
    broadcast: (next) => onScopeChanged?.(next),
    listeningForBroadcasts: () => onScopeChanged !== null,
    // Browser semantics: the other window's write has landed before the event fires here.
    setActiveWorkspace: (id) => {
      storage.setItem("activeWorkspaceId", id);
      events.dispatch("storage", { key: "activeWorkspaceId", newValue: id });
    },
  };
}

test("a window without a session hydrates managed transcription from the main process scope", async (t) => {
  const { managed, calls, broadcast, usePolicyStore, useEnterpriseIdentityStore } = await boot(t, {
    scope: { accountId: "account-a", authGeneration: 1 },
    activeWorkspaceId: "workspace-a",
  });
  await waitFor(() => managed.isManagedTranscriptionActive(), "managed transcription");
  const resolution = managed.getManagedTranscriptionResolution();
  assert.equal(resolution.kind, "managed");
  assert.equal(resolution.provider, "azure");
  assert.equal(resolution.deployment, "gpt-4o-transcribe");
  assert.deepEqual(
    [
      resolution.context.accountId,
      resolution.context.workspaceId,
      resolution.context.authGeneration,
    ],
    ["account-a", "workspace-a", 1]
  );
  assert.deepEqual(calls.policy, [["account-a", 1]]);
  assert.deepEqual(calls.config, [["account-a", "workspace-a", 1]]);

  await t.test("a new credential generation re-resolves policy and identity", async () => {
    broadcast({ accountId: "account-a", authGeneration: 2 });
    await waitFor(
      () => managed.getManagedTranscriptionResolution()?.context?.authGeneration === 2,
      "generation 2"
    );
    assert.deepEqual(calls.policy.at(-1), ["account-a", 2]);
    assert.deepEqual(calls.config.at(-1), ["account-a", "workspace-a", 2]);
    assert.equal(managed.isManagedTranscriptionActive(), true);
  });

  await t.test("a cleared scope (sign-out) clears the mirrored identity at once", () => {
    broadcast(null);
    assert.equal(managed.isManagedTranscriptionActive(), false);
    assert.equal(managed.getManagedTranscriptionResolution(), undefined);
    assert.equal(usePolicyStore.getState().status, "idle");
    assert.equal(useEnterpriseIdentityStore.getState().status, "idle");
    assert.equal(useEnterpriseIdentityStore.getState().accountId, null);
  });
});

test("a scope validated after boot arrives by broadcast and the workspace by storage", async (t) => {
  const { managed, calls, broadcast, setActiveWorkspace, usePolicyStore } = await boot(t);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(managed.isManagedTranscriptionActive(), false);
  assert.deepEqual(calls.policy, []);

  broadcast({ accountId: "account-a", authGeneration: 1 });
  await waitFor(() => usePolicyStore.getState().status === "managed", "policy");
  // No active workspace is known yet, so nothing can be managed.
  assert.equal(managed.isManagedTranscriptionActive(), false);
  assert.deepEqual(calls.config, []);

  setActiveWorkspace("workspace-a");
  await waitFor(() => managed.isManagedTranscriptionActive(), "managed transcription");
  assert.deepEqual(calls.config, [["account-a", "workspace-a", 1]]);
});

test("a broadcast that lands while the boot read is in flight is not overwritten by it", async (t) => {
  let resolveRead;
  const { managed, broadcast } = await boot(t, {
    activeWorkspaceId: "workspace-a",
    readScope: () => new Promise((resolve) => (resolveRead = resolve)),
  });
  broadcast({ accountId: "account-a", authGeneration: 1 });
  await waitFor(() => managed.isManagedTranscriptionActive(), "managed transcription");
  resolveRead(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(managed.isManagedTranscriptionActive(), true);
});

test("stopping the mirror detaches both the broadcast and the storage listener", async (t) => {
  const { stop, events, listeningForBroadcasts } = await boot(t, {
    activeWorkspaceId: "workspace-a",
  });
  assert.equal(events.count("storage"), 1);
  assert.equal(listeningForBroadcasts(), true);
  stop();
  assert.equal(events.count("storage"), 0);
  assert.equal(listeningForBroadcasts(), false);
});
