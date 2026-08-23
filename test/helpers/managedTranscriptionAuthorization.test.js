const test = require("node:test");
const assert = require("node:assert/strict");

const {
  authorizeManagedTranscription,
} = require("../../src/helpers/managedTranscriptionAuthorization");

const managedContext = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  policyRevision: 3,
  category: "transcription",
  transcriptionMode: "local",
  provider: "whisper",
  model: "small",
  managed: true,
};

const managedPolicyResult = {
  success: true,
  revision: 3,
  accountId: "account-a",
  authGeneration: 7,
  managed: true,
  policy: {
    version: 1,
    transcription: { allowedModes: ["local"], allowedByokProviders: [] },
    llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
    features: { agentEnabled: false, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: 30,
      localHistoryMode: "always_off",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  },
};

const managedConfigResult = {
  success: true,
  status: "current",
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  config: {
    workspaceId: "workspace-a",
    generation: 11,
    localModels: {
      transcription: [{ provider: "whisper", modelId: "small" }],
      reasoning: [],
    },
  },
};

const authorize = (overrides = {}) =>
  authorizeManagedTranscription({
    context: managedContext,
    requestedProvider: "whisper",
    requestedModel: "small",
    requestedMode: "local",
    currentAuthGeneration: 7,
    resolveConfig: async () => managedConfigResult,
    resolvePolicy: async () => managedPolicyResult,
    ...overrides,
  });

test("guest transcription remains compatible without a runtime context", async () => {
  await assert.doesNotReject(
    authorize({
      context: undefined,
      requestedProvider: "openwhispr",
      requestedModel: null,
      currentAuthGeneration: null,
    })
  );
});

test("guest transcription rejects a stale signed-in or mismatched runtime context", async (t) => {
  const cases = [
    { name: "signed-in identity", context: { ...managedContext, managed: false } },
    {
      name: "mismatched route",
      context: {
        ...managedContext,
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        provider: "openai",
        model: "whisper-1",
        managed: false,
      },
    },
    {
      name: "stale config generation",
      context: {
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        configGeneration: 11,
        category: "transcription",
        provider: "openwhispr",
        model: null,
        managed: false,
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      await assert.rejects(
        authorize({
          context: testCase.context,
          requestedProvider: "openwhispr",
          requestedModel: null,
          currentAuthGeneration: null,
        }),
        { code: "AUTHORIZATION_BOUNDARY_CHANGED" }
      );
    });
  }
});

test("authoritatively unmanaged transcription accepts an exact personal route", async () => {
  const context = {
    ...managedContext,
    configGeneration: null,
    transcriptionMode: "providers",
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    managed: false,
  };
  await assert.doesNotReject(
    authorize({
      context,
      requestedProvider: "openai",
      requestedModel: "gpt-4o-mini-transcribe",
      requestedMode: "providers",
      resolvePolicy: async () => ({
        ...managedPolicyResult,
        managed: false,
        policy: null,
      }),
      resolveConfig: async () => ({
        success: false,
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        code: "ENTERPRISE_REQUIRED",
        enforcementRequired: false,
      }),
    })
  );
});

test("authoritatively unmanaged transcription rejects a stale config generation", async () => {
  await assert.rejects(
    authorize({
      context: {
        ...managedContext,
        transcriptionMode: "providers",
        provider: "openai",
        model: "gpt-4o-mini-transcribe",
        managed: false,
      },
      requestedProvider: "openai",
      requestedModel: "gpt-4o-mini-transcribe",
      requestedMode: "providers",
      resolvePolicy: async () => ({
        ...managedPolicyResult,
        managed: false,
        policy: null,
      }),
      resolveConfig: async () => ({
        success: false,
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        code: "ENTERPRISE_REQUIRED",
        enforcementRequired: false,
      }),
    }),
    { code: "AUTHORIZATION_BOUNDARY_CHANGED" }
  );
});

test("authenticated transcription rejects a missing runtime context", async () => {
  await assert.rejects(authorize({ context: undefined }), {
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
});

test("identity, auth, config, and exact route changes invalidate the context", async (t) => {
  const cases = [
    {
      name: "account",
      overrides: {
        resolveConfig: async () => ({ ...managedConfigResult, accountId: "account-b" }),
      },
    },
    {
      name: "workspace",
      overrides: {
        resolveConfig: async () => ({ ...managedConfigResult, workspaceId: "workspace-b" }),
      },
    },
    { name: "auth generation", overrides: { currentAuthGeneration: 8 } },
    {
      name: "config generation",
      overrides: {
        resolveConfig: async () => ({
          ...managedConfigResult,
          config: { ...managedConfigResult.config, generation: 12 },
        }),
      },
    },
    { name: "provider", overrides: { requestedProvider: "nvidia" } },
    { name: "model", overrides: { requestedModel: "medium" } },
  ];

  for (const { name, overrides } of cases) {
    await t.test(name, async () => {
      await assert.rejects(authorize(overrides), {
        code: "AUTHORIZATION_BOUNDARY_CHANGED",
      });
    });
  }
});

test("unresolved enterprise enforcement fails closed", async () => {
  await assert.rejects(
    authorize({
      resolveConfig: async () => ({
        success: false,
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        code: "MANAGED_CONFIG_UNAVAILABLE",
      }),
    }),
    { code: "MANAGED_CONFIG_UNAVAILABLE" }
  );
});

test("managed-local enforcement rejects cloud and renderer-unmanaged routes", async () => {
  await assert.rejects(
    authorize({
      context: {
        ...managedContext,
        provider: "openwhispr",
        model: null,
        managed: false,
      },
      requestedProvider: "openwhispr",
      requestedModel: null,
    }),
    { code: "MANAGED_MODEL_REQUIRED" }
  );
});

test("managed-local enforcement rejects an unapproved local model", async () => {
  await assert.rejects(
    authorize({
      context: { ...managedContext, model: "medium" },
      requestedModel: "medium",
    }),
    { code: "MANAGED_MODEL_REQUIRED" }
  );
});

test("managed-local enforcement requires an exact boolean managed assignment", async (t) => {
  for (const managed of [false, 1, "true", {}]) {
    await t.test(String(managed), async () => {
      await assert.rejects(authorize({ context: { ...managedContext, managed } }), {
        code: "MANAGED_MODEL_REQUIRED",
      });
    });
  }
});

test("managed-local enforcement accepts the exact approved local route", async () => {
  await assert.doesNotReject(authorize());
});

test("workspace policy rejects a provider route even when managed-local models are absent", async () => {
  const context = {
    ...managedContext,
    transcriptionMode: "providers",
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    managed: false,
  };

  await assert.rejects(
    authorize({
      context,
      requestedProvider: "openai",
      requestedModel: "gpt-4o-mini-transcribe",
      requestedMode: "providers",
      resolveConfig: async () => ({
        ...managedConfigResult,
        config: {
          ...managedConfigResult.config,
          localModels: { transcription: [], reasoning: [] },
        },
      }),
    }),
    { code: "POLICY_RESTRICTED" }
  );
});

test("a stale workspace-policy revision invalidates transcription admission", async () => {
  await assert.rejects(
    authorize({
      resolvePolicy: async () => ({ ...managedPolicyResult, revision: 4 }),
    }),
    { code: "AUTHORIZATION_BOUNDARY_CHANGED" }
  );
});

test("a workspace minimum app version is enforced by main admission", async () => {
  await assert.rejects(
    authorize({
      currentAppVersion: "1.8.4",
      resolvePolicy: async () => ({
        ...managedPolicyResult,
        policy: { ...managedPolicyResult.policy, minAppVersion: "2.0.0" },
      }),
    }),
    { code: "POLICY_RESTRICTED" }
  );
});
