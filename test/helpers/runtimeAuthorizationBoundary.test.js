const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

const load = () => import("../../src/helpers/runtimeAuthorizationBoundary.ts");

const unmanagedPolicy = {
  accountId: "account-a",
  authGeneration: 1,
  status: "unmanaged",
  appVersion: "1.8.4",
  policy: null,
};

const managedPolicy = {
  accountId: "account-a",
  authGeneration: 1,
  status: "managed",
  appVersion: "1.8.4",
  policy: {
    version: 1,
    transcription: {
      allowedModes: ["providers", "local"],
      allowedByokProviders: ["groq", "openai"],
    },
    llm: {
      allowedModes: ["providers", "local"],
      allowedByokProviders: ["openai", "anthropic"],
      allowedEnterpriseProviders: ["azure", "bedrock"],
    },
    features: {
      agentEnabled: true,
      webSearchEnabled: false,
      screenContextEnabled: true,
    },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  },
};

const baseSnapshot = {
  identity: {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    configGeneration: 4,
  },
  managedLock: {
    managed: true,
    selection: { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
  },
  policy: managedPolicy,
};

test("authorization signature changes at identity and exact managed-model boundaries", async () => {
  const { buildRuntimeAuthorizationSignature } = await load();
  const initial = buildRuntimeAuthorizationSignature("reasoning", baseSnapshot);

  for (const changed of [
    {
      ...baseSnapshot,
      identity: { ...baseSnapshot.identity, accountId: "account-b" },
    },
    {
      ...baseSnapshot,
      identity: { ...baseSnapshot.identity, workspaceId: "workspace-b" },
    },
    {
      ...baseSnapshot,
      identity: { ...baseSnapshot.identity, authGeneration: 2 },
    },
    {
      ...baseSnapshot,
      identity: { ...baseSnapshot.identity, configGeneration: 5 },
    },
    {
      ...baseSnapshot,
      managedLock: {
        managed: true,
        selection: { provider: "qwen", modelId: "qwen3.5-8b-q4_k_m" },
      },
    },
    {
      ...baseSnapshot,
      managedLock: { managed: true, selection: null },
    },
  ]) {
    assert.notEqual(buildRuntimeAuthorizationSignature("reasoning", changed), initial);
  }
});

test("authorization signature changes only for policy decisions relevant to its domain", async () => {
  const { buildRuntimeAuthorizationSignature } = await load();
  const reasoning = buildRuntimeAuthorizationSignature("reasoning", baseSnapshot);
  const transcription = buildRuntimeAuthorizationSignature("transcription", baseSnapshot);

  const transcriptionRevoked = structuredClone(baseSnapshot);
  transcriptionRevoked.policy.policy.transcription.allowedModes = ["local"];
  assert.equal(
    buildRuntimeAuthorizationSignature("reasoning", transcriptionRevoked),
    reasoning,
    "transcription policy must not cancel unrelated reasoning work"
  );
  assert.notEqual(
    buildRuntimeAuthorizationSignature("transcription", transcriptionRevoked),
    transcription
  );

  const reasoningRevoked = structuredClone(baseSnapshot);
  reasoningRevoked.policy.policy.llm.allowedModes = ["local"];
  assert.notEqual(buildRuntimeAuthorizationSignature("reasoning", reasoningRevoked), reasoning);
  assert.equal(
    buildRuntimeAuthorizationSignature("transcription", reasoningRevoked),
    transcription,
    "reasoning policy must not cancel unrelated transcription work"
  );
});

test("equivalent policy ordering and refresh metadata do not cancel active work", async () => {
  const { buildRuntimeAuthorizationSignature } = await load();
  const initial = buildRuntimeAuthorizationSignature("reasoning", baseSnapshot);
  const reordered = structuredClone(baseSnapshot);
  reordered.policy.policy.version = 99;
  reordered.policy.policy.llm.allowedModes.reverse();
  reordered.policy.policy.llm.allowedByokProviders.reverse();
  reordered.policy.policy.llm.allowedEnterpriseProviders.reverse();

  assert.equal(buildRuntimeAuthorizationSignature("reasoning", reordered), initial);
  assert.equal(
    buildRuntimeAuthorizationSignature("reasoning", {
      ...baseSnapshot,
      policy: unmanagedPolicy,
    }),
    buildRuntimeAuthorizationSignature("reasoning", {
      ...baseSnapshot,
      policy: { ...unmanagedPolicy, appVersion: "1.8.5" },
    })
  );
});

test("managed binding events cancel subscribers when the exact model changes", async (t) => {
  const events = new EventTarget();
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  });
  const { MANAGED_LOCAL_MODEL_BINDINGS_KEY } =
    await import("../../src/components/onboarding/managedLocalModels.ts");
  const { useEnterpriseIdentityStore } =
    await import("../../src/stores/enterpriseIdentityStore.ts");
  const { usePolicyStore } = await import("../../src/stores/policyStore.ts");
  const { subscribeRuntimeAuthorizationBoundary } = await load();
  const reasoning = [
    { provider: "qwen", modelId: "qwen3.5-4b-q4_k_m" },
    { provider: "qwen", modelId: "qwen3.5-8b-q4_k_m" },
  ];
  localStorage.setItem(
    MANAGED_LOCAL_MODEL_BINDINGS_KEY,
    JSON.stringify({
      "account-a:workspace-a": {
        configVersion: 2,
        transcription: null,
        reasoning: reasoning[0],
        error: null,
      },
    })
  );
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: {
      workspaceId: "workspace-a",
      version: 2,
      generation: 4,
      identity: {
        issuer: "issuer",
        jwksUri: "jwks",
        subject: "subject",
        audiences: { bedrock: "bedrock", azure: "azure" },
      },
      providers: [],
      localModels: {
        transcription: [],
        reasoning,
        version: 2,
        updatedAt: "2026-08-20T00:00:00.000Z",
        updatedByUserId: null,
      },
    },
    lastKnownLocalModels: null,
    lastKnownLocalModelsKnown: true,
    failClosed: false,
  });
  usePolicyStore.setState({ status: "unmanaged", policy: null, appVersion: "1.8.4" });

  let changes = 0;
  const unsubscribe = subscribeRuntimeAuthorizationBoundary("reasoning", () => {
    changes += 1;
  });
  t.after(unsubscribe);
  localStorage.setItem(
    MANAGED_LOCAL_MODEL_BINDINGS_KEY,
    JSON.stringify({
      "account-a:workspace-a": {
        configVersion: 2,
        transcription: null,
        reasoning: reasoning[1],
        error: null,
      },
    })
  );
  globalThis.window.dispatchEvent(new Event("openwhispr-managed-local-model-binding"));

  assert.equal(changes, 1);
});

test("an authorization lease cancels once and rejects all later work", async () => {
  const { captureRuntimeAuthorizationLease } = await load();
  const { useEnterpriseIdentityStore } =
    await import("../../src/stores/enterpriseIdentityStore.ts");
  let cancellations = 0;
  const lease = captureRuntimeAuthorizationLease("transcription", () => {
    cancellations += 1;
  });

  useEnterpriseIdentityStore.setState((state) => ({
    authGeneration: (state.authGeneration ?? 0) + 1,
  }));
  useEnterpriseIdentityStore.setState((state) => ({
    authGeneration: (state.authGeneration ?? 0) + 1,
  }));

  assert.equal(cancellations, 1);
  assert.equal(lease.isCurrent(), false);
  assert.throws(() => lease.assertCurrent(), { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
  lease.dispose();
});
