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
