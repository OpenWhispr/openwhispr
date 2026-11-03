const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const esTranslations = require("../../src/locales/es/translation.json");
const enTranslations = require("../../src/locales/en/translation.json");

test("reasoning policy asserts throw messages localized to the active UI language", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-policy-test-",
  });

  const { assertAgentAllowedByPolicy, assertReasoningAllowedByPolicy } = await vite.ssrLoadModule(
    "/services/reasoningPolicy.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");

  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.8.1",
    policy: {
      version: 1,
      transcription: { allowedModes: [], allowedByokProviders: [] },
      llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
      features: { agentEnabled: false, webSearchEnabled: false },
      sharing: { externalLinkSharing: "disabled" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: false,
      },
      minAppVersion: null,
    },
  });

  await i18n.changeLanguage("es");
  assert.notEqual(
    esTranslations.common.policyAgentRestricted,
    enTranslations.common.policyAgentRestricted,
    "the localized strings must differ so this test can prove translation happened"
  );

  assert.throws(() => assertAgentAllowedByPolicy(), {
    message: esTranslations.common.policyAgentRestricted,
  });
  assert.throws(() => assertReasoningAllowedByPolicy("openai", "providers"), {
    message: esTranslations.common.policyAiProcessingRestricted,
  });

  await i18n.changeLanguage("en");
  assert.throws(() => assertAgentAllowedByPolicy(), {
    message: enTranslations.common.policyAgentRestricted,
  });
});

test("the model factory preserves a permitted self-hosted route without granting local or BYOK", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-self-hosted-policy-test-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getAIModel } = await vite.ssrLoadModule("/services/ai/providers.ts");
  const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");
  const policy = defaultDevicePolicy();
  policy.llm.allowedModes = ["self-hosted"];
  usePolicyStore.setState({ status: "managed", policy, appVersion: "1.11.1" });
  assert.ok(
    await getAIModel("local", "local-model", "", "https://lan.example.test/v1", {
      mode: "self-hosted",
    })
  );
  await assert.rejects(getAIModel("local", "local-model", "", "http://127.0.0.1:9999/v1"));
  await assert.rejects(getAIModel("openai", "gpt-test", "saved-key"));
});
