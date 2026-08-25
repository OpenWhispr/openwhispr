const test = require("node:test");
const assert = require("node:assert/strict");

const {
  authorizeManagedInferenceStart,
} = require("../../src/helpers/managedInferenceAuthorization");

const identity = Object.freeze({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
});

const managedLocalConfig = {
  success: true,
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  config: {
    workspaceId: "workspace-a",
    generation: 11,
    providers: [],
    localModels: {
      selections: [
        { provider: "whisper", model: "small" },
        { provider: "llama-cpp", model: "qwen3-4b" },
      ],
    },
  },
};

const managedCloudConfig = {
  success: true,
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  config: {
    workspaceId: "workspace-a",
    generation: 12,
    localModels: undefined,
    providers: [
      {
        provider: "azure",
        mode: "managed_required",
        allowManualSetup: false,
        config: { scopeDefaults: { chatIntelligence: "deployment-chat" } },
      },
    ],
  },
};

const claim = (overrides = {}) => ({
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 11,
  managed: true,
  provider: "whisper",
  model: "small",
  ...overrides,
});

const route = (overrides = {}) => ({
  domain: "transcription",
  provider: "whisper",
  model: "small",
  ...overrides,
});

test("start admission returns only the literal exact route or a stable rejection", async (t) => {
  const rows = [
    {
      name: "guest shape",
      claim: claim({
        accountId: null,
        workspaceId: null,
        authGeneration: null,
        configGeneration: null,
        managed: false,
        provider: "self-hosted",
        model: "whisper-large-v3",
      }),
      actualRoute: route({ provider: "self-hosted", model: "whisper-large-v3" }),
      authState: { token: null, generation: 0 },
      active: null,
      config: null,
      want: { managed: false, provider: "self-hosted", model: "whisper-large-v3" },
    },
    {
      name: "exact current-session unmanaged",
      claim: claim({ configGeneration: null, managed: false, provider: "openai", model: "gpt-4o-transcribe" }),
      actualRoute: route({ provider: "openai", model: "gpt-4o-transcribe" }),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: {
        success: true,
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        config: null,
        enforcementRequired: false,
      },
      want: { managed: false, provider: "openai", model: "gpt-4o-transcribe" },
    },
    {
      name: "missing workspace",
      claim: claim({ workspaceId: null, configGeneration: null, managed: false }),
      actualRoute: route(),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedLocalConfig,
      wantCode: "MANAGED_WORKSPACE_REQUIRED",
    },
    {
      name: "missing active identity",
      claim: claim(),
      actualRoute: route(),
      authState: { token: "session", generation: 7 },
      active: null,
      config: managedLocalConfig,
      wantCode: "AUTHORIZATION_BOUNDARY_CHANGED",
    },
    {
      name: "stale active identity",
      claim: claim(),
      actualRoute: route(),
      authState: { token: "session", generation: 7 },
      active: Object.freeze({ ...identity, workspaceId: "workspace-b" }),
      config: managedLocalConfig,
      wantCode: "AUTHORIZATION_BOUNDARY_CHANGED",
    },
    {
      name: "token generation drift",
      claim: claim(),
      actualRoute: route(),
      authState: { token: "session", generation: 8 },
      active: identity,
      config: managedLocalConfig,
      wantCode: "AUTHORIZATION_BOUNDARY_CHANGED",
    },
    {
      name: "config generation drift",
      claim: claim({ configGeneration: 10 }),
      actualRoute: route(),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedLocalConfig,
      wantCode: "AUTHORIZATION_BOUNDARY_CHANGED",
    },
    {
      name: "unknown config",
      claim: claim(),
      actualRoute: route(),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: {
        success: false,
        accountId: "account-a",
        workspaceId: "workspace-a",
        authGeneration: 7,
        code: "MANAGED_CONFIG_UNAVAILABLE",
      },
      wantCode: "MANAGED_CONFIG_UNAVAILABLE",
    },
    {
      name: "exact managed transcription",
      claim: claim(),
      actualRoute: route(),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedLocalConfig,
      want: { managed: true, provider: "whisper", model: "small" },
    },
    {
      name: "managed transcription blocks cloud",
      claim: claim({ managed: false, provider: "openai", model: "gpt-4o-transcribe" }),
      actualRoute: route({ provider: "openai", model: "gpt-4o-transcribe" }),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedLocalConfig,
      wantCode: "AUTHORIZATION_BOUNDARY_CHANGED",
    },
    {
      name: "managed transcription blocks unapproved local",
      claim: claim({ model: "medium" }),
      actualRoute: route({ model: "medium" }),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedLocalConfig,
      wantCode: "AUTHORIZATION_BOUNDARY_CHANGED",
    },
    {
      name: "managed local reasoning",
      claim: claim({ provider: "llama-cpp", model: "qwen3-4b" }),
      actualRoute: route({ domain: "reasoning", provider: "llama-cpp", model: "qwen3-4b", inferenceScope: "chatIntelligence", setupMode: "auto" }),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedLocalConfig,
      want: { managed: true, provider: "llama-cpp", model: "qwen3-4b" },
    },
    {
      name: "managed cloud reasoning",
      claim: claim({ configGeneration: 12, provider: "azure", model: "deployment-chat" }),
      actualRoute: route({ domain: "reasoning", provider: "azure", model: "deployment-chat", inferenceScope: "chatIntelligence", setupMode: "auto" }),
      authState: { token: "session", generation: 7 },
      active: identity,
      config: managedCloudConfig,
      want: { managed: true, provider: "azure", model: "deployment-chat" },
    },
  ];

  for (const row of rows) {
    await t.test(row.name, async () => {
      let currentIdentity = row.active;
      const input = {
        claim: row.claim,
        actualRoute: row.actualRoute,
        authState: row.authState,
        activeIdentity: () => currentIdentity,
        getConfig: async () => row.config,
      };
      if (row.wantCode) {
        await assert.rejects(authorizeManagedInferenceStart(input), { code: row.wantCode });
      } else {
        assert.deepEqual(await authorizeManagedInferenceStart(input), row.want);
      }
      currentIdentity = null;
    });
  }
});

test("identity replacement while config lookup awaits rejects the old start", async () => {
  let currentIdentity = identity;
  let releaseConfig;
  const configPending = new Promise((resolve) => {
    releaseConfig = resolve;
  });
  const pending = authorizeManagedInferenceStart({
    claim: claim(),
    actualRoute: route(),
    authState: { token: "session", generation: 7 },
    activeIdentity: () => currentIdentity,
    getConfig: () => configPending,
  });

  currentIdentity = Object.freeze({ ...identity, workspaceId: "workspace-b" });
  releaseConfig(managedLocalConfig);

  await assert.rejects(pending, { code: "AUTHORIZATION_BOUNDARY_CHANGED" });
});
