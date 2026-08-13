const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictationTranslationInference.js");

const baseSettings = {
  useDictationTranslation: true,
  translationTargetLanguage: "es",
  translationMode: "providers",
  translationProvider: "openai",
  translationModel: "gpt-5-mini",
  translationRemoteUrl: "",
  translationCloudBaseUrl: "",
  translationCustomApiKey: "",
  translationDisableThinking: true,
};

test("providers mode keeps its explicit provider and translation settings", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference(baseSettings);

  assert.equal(result.reachable, true);
  assert.equal(result.model, "gpt-5-mini");
  assert.equal(result.config.provider, "openai");
  assert.equal(result.config.language, "es");
  assert.equal(result.config.disableThinking, true);
});

test("local mode routes to llama.cpp with an empty stored provider", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "local",
    translationProvider: "",
    translationModel: "qwen2.5-coder",
  });

  assert.equal(result.reachable, true);
  assert.equal(result.displayProvider, "local");
  assert.equal(result.config.provider, "local");
});

test("local mode ignores a stale cloud provider", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "local",
    translationProvider: "openai",
    translationModel: "qwen2.5-coder",
  });

  assert.equal(result.config.provider, "local");
});

test("self-hosted mode routes only through its configured endpoint", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "self-hosted",
    translationProvider: "openai",
    translationModel: "",
    translationRemoteUrl: "http://127.0.0.1:8080/v1",
    translationCustomApiKey: "lan-key",
  });

  assert.equal(result.reachable, true);
  assert.equal(result.displayProvider, "self-hosted");
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.lanUrl, "http://127.0.0.1:8080/v1");
  assert.equal(result.config.customApiKey, "lan-key");
});

test("self-hosted mode without an endpoint never falls through to cloud inference", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "self-hosted",
    translationProvider: "openai",
    translationRemoteUrl: "",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.lanUrl, undefined);
});

test("available managed mode resolves OpenWhispr without requiring a model", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference(
    {
      ...baseSettings,
      translationMode: "openwhispr",
      translationModel: "",
    },
    { isCloudTranslation: true }
  );

  assert.equal(result.reachable, true);
  assert.equal(result.displayProvider, "openwhispr");
  assert.equal(result.config.provider, "openwhispr");
});

test("managed mode never falls through to a stale provider when signed out", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "openwhispr",
    translationProvider: "openai",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.displayProvider, "openwhispr");
  assert.equal(result.config.provider, undefined);
});

test("provider mode rejects a stale local catalog provider", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationProvider: "qwen",
    translationModel: "qwen2.5-coder",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.displayProvider, "none");
  assert.equal(result.config.provider, undefined);
});

test("custom provider credentials stay scoped to custom mode", async () => {
  const { resolveDictationTranslationInference } = await load();

  const custom = resolveDictationTranslationInference({
    ...baseSettings,
    translationProvider: "custom",
    translationCloudBaseUrl: "https://example.test/v1",
    translationCustomApiKey: "secret",
  });
  const openai = resolveDictationTranslationInference({
    ...baseSettings,
    translationCloudBaseUrl: "https://example.test/v1",
    translationCustomApiKey: "secret",
  });

  assert.equal(custom.config.baseUrl, "https://example.test/v1");
  assert.equal(custom.config.customApiKey, "secret");
  assert.equal(openai.config.baseUrl, undefined);
  assert.equal(openai.config.customApiKey, undefined);
});

test("enterprise mode without a provider fails closed", async () => {
  const { resolveDictationTranslationInference } = await load();

  const result = resolveDictationTranslationInference({
    ...baseSettings,
    translationMode: "enterprise",
    translationProvider: "",
    translationModel: "anthropic.claude-sonnet-4",
  });

  assert.equal(result.reachable, false);
  assert.equal(result.config.provider, undefined);
});

test("managed enterprise access supplies the provider and model, ignoring manual settings", async (t) => {
  const { resolveDictationTranslationInference } = await load();
  const { useEnterpriseIdentityStore } = await import(
    "../../src/stores/enterpriseIdentityStore.ts"
  );

  const scopes = [
    "dictationCleanup",
    "dictationAgent",
    "noteFormatting",
    "chatIntelligence",
    "dictationTranslation",
  ];
  useEnterpriseIdentityStore.setState({
    status: "ready",
    config: {
      workspaceId: "workspace-a",
      version: 1,
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
            allowedModels: ["managed-model"],
            scopeDefaults: Object.fromEntries(scopes.map((scope) => [scope, "managed-model"])),
          },
          version: 1,
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    },
  });
  t.after(() => useEnterpriseIdentityStore.setState({ status: "idle", config: null }));

  // A stale self-hosted endpoint and key must not leak into a managed request.
  const result = resolveDictationTranslationInference({
    ...baseSettings,
    enterpriseSetupMode: "auto",
    translationMode: "self-hosted",
    translationRemoteUrl: "http://192.0.2.1:8080",
    translationCustomApiKey: "secret",
  });

  assert.equal(result.reachable, true);
  assert.equal(result.model, "managed-model");
  assert.equal(result.displayProvider, "bedrock");
  assert.equal(result.config.provider, "bedrock");
  assert.equal(result.config.inferenceScope, "dictationTranslation");
  assert.equal(result.config.language, "es");
  assert.equal(result.config.lanUrl, undefined);
  assert.equal(result.config.customApiKey, undefined);
});
