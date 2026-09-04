const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const enTranslations = require("../../src/locales/en/translation.json");

const REASONING_RESTRICTED = enTranslations.common.policyAiProcessingRestricted;

const SCOPES = [
  "dictationCleanup",
  "dictationAgent",
  "noteFormatting",
  "chatIntelligence",
  "dictationTranslation",
];

const MANAGED_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";

function managedBedrockConfig() {
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
          allowedModels: [MANAGED_MODEL],
          scopeDefaults: Object.fromEntries(SCOPES.map((scope) => [scope, MANAGED_MODEL])),
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
}

function buildPolicy({ llmModes, llmEnterpriseProviders = [] }) {
  return {
    version: 1,
    transcription: { allowedModes: [], allowedByokProviders: [] },
    llm: {
      allowedModes: llmModes,
      allowedByokProviders: [],
      allowedEnterpriseProviders: llmEnterpriseProviders,
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
}

// Regression: a self-hosted endpoint left over from before the administrator enabled managed
// access used to win the route, so prompts left through the employee's own server while the UI
// reported "Managed by your organization" — silently defeating managed_required.
test("managed enterprise access outranks a leftover self-hosted route", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-routing-test-",
  });

  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");

  // The employee still has a self-hosted cleanup endpoint configured.
  useSettingsStore.setState({
    enterpriseSetupMode: "auto",
    cleanupMode: "self-hosted",
    cleanupRemoteUrl: "http://192.0.2.1:8080",
  });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: managedBedrockConfig(),
    error: null,
  });

  const setPolicy = (overrides) =>
    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.8.1",
      policy: buildPolicy(overrides),
    });

  // An enterprise-only policy is the observation mechanism: it admits the managed route and
  // rejects the self-hosted one, so the outcome names the route that was chosen without ever
  // opening a socket.
  const enterpriseOnly = { llmModes: ["enterprise"], llmEnterpriseProviders: ["bedrock"] };

  await t.test("the stale self-hosted mode does not capture the route", async () => {
    setPolicy(enterpriseOnly);
    await assert.rejects(
      reasoningService.processText("hi", "", null, { inferenceScope: "dictationCleanup" }),
      (error) => error.message !== REASONING_RESTRICTED
    );
  });

  await t.test("an explicit per-call lanUrl does not capture the route either", async () => {
    setPolicy(enterpriseOnly);
    await assert.rejects(
      reasoningService.processText("hi", "", null, {
        inferenceScope: "noteFormatting",
        lanUrl: "http://192.0.2.9:9090",
      }),
      (error) => error.message !== REASONING_RESTRICTED
    );
  });

  await t.test("without managed access the self-hosted route still wins", async () => {
    useEnterpriseIdentityStore.setState({ config: null, status: "idle" });
    setPolicy(enterpriseOnly);
    await assert.rejects(
      reasoningService.processText("hi", "", null, {
        inferenceScope: "dictationCleanup",
        lanUrl: "http://192.0.2.1:8080",
      }),
      { message: REASONING_RESTRICTED }
    );
  });
});

test("enterprise call settings cannot omit or bypass a resolved managed route", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-call-settings-test-",
  });
  const { getEnterpriseCallSettings } = await vite.ssrLoadModule(
    "/services/ai/enterpriseSettings.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  useSettingsStore.setState({ enterpriseSetupMode: "auto" });
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: buildPolicy({ llmModes: ["enterprise"], llmEnterpriseProviders: ["bedrock"] }),
  });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: managedBedrockConfig(),
    error: null,
    failClosed: false,
  });

  const settings = getEnterpriseCallSettings("azure", "dictationCleanup");
  assert.equal(settings.managedContext.provider, "bedrock");
  assert.equal(settings.managedContext.generation, 1);

  useEnterpriseIdentityStore.setState({
    status: "error",
    config: null,
    error: "Company SSO is required",
    failClosed: true,
  });
  assert.throws(
    () => getEnterpriseCallSettings("azure", "dictationCleanup"),
    (error) => error.code === "MANAGED_CONFIG_UNAVAILABLE"
  );
});

test("required managed access fails closed when workspace policy forbids it", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-policy-gate-test-",
  });

  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useSettingsStore, selectResolvedLLMConfig } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );

  useSettingsStore.setState({
    enterpriseSetupMode: "auto",
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "qwen-local",
  });
  useEnterpriseIdentityStore.setState({ status: "ready", config: managedBedrockConfig() });

  const resolvedMode = () =>
    selectResolvedLLMConfig(useSettingsStore.getState(), "dictationCleanup");

  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: buildPolicy({ llmModes: ["enterprise"], llmEnterpriseProviders: ["bedrock"] }),
  });
  assert.equal(resolvedMode().provider, "bedrock", "allowed managed provider applies");

  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: buildPolicy({ llmModes: ["local"], llmEnterpriseProviders: [] }),
  });
  const blocked = resolvedMode();
  assert.equal(blocked.mode, "enterprise");
  assert.equal(blocked.provider, "");
  assert.equal(blocked.model, "");

  useEnterpriseIdentityStore.setState({
    status: "error",
    config: null,
    error: "Sign in with company SSO",
    failClosed: true,
  });
  const unavailable = resolvedMode();
  assert.equal(unavailable.mode, "enterprise");
  assert.equal(unavailable.provider, "");
  assert.equal(unavailable.model, "");
});
