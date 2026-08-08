const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const enTranslations = require("../../src/locales/en/translation.json");

// Exact localized messages: if an assert call site were removed, these calls
// would surface "No reasoning model selected" or a dispatch error instead.
const AGENT_RESTRICTED = enTranslations.common.policyAgentRestricted;
const REASONING_RESTRICTED = enTranslations.common.policyAiProcessingRestricted;

function buildPolicy({ agentEnabled = true, llmModes = [], llmByokProviders = [] } = {}) {
  return {
    version: 1,
    transcription: { allowedModes: [], allowedByokProviders: [] },
    llm: {
      allowedModes: llmModes,
      allowedByokProviders: llmByokProviders,
      allowedEnterpriseProviders: [],
    },
    features: { agentEnabled, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  };
}

test("ReasoningService entry points enforce the org policy", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-reasoning-enforcement-test-",
  });

  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");

  const setPolicy = (overrides) => {
    usePolicyStore.setState({
      status: "managed",
      appVersion: "1.8.1",
      policy: buildPolicy(overrides),
    });
  };

  await t.test("processText rejects a BYOK provider outside the allowlist", async () => {
    setPolicy({ llmModes: ["providers"], llmByokProviders: ["anthropic"] });
    await assert.rejects(
      reasoningService.processText("hi", "gpt-4.1", null, { provider: "openai" }),
      {
        message: REASONING_RESTRICTED,
      }
    );
  });

  await t.test("processText rejects agent commands when the agent is disabled", async () => {
    setPolicy({ agentEnabled: false, llmModes: ["providers"], llmByokProviders: ["openai"] });
    await assert.rejects(
      reasoningService.processText("hi", "gpt-4.1", null, {
        provider: "openai",
        requiresAgent: true,
      }),
      { message: AGENT_RESTRICTED }
    );
  });

  await t.test("dispatch-mode mapping: a LAN config is judged as self-hosted", async () => {
    setPolicy({ llmModes: ["providers"], llmByokProviders: ["openai"] });
    await assert.rejects(
      reasoningService.processText("hi", "some-model", null, {
        lanUrl: "http://192.0.2.1:8080",
      }),
      { message: REASONING_RESTRICTED }
    );
  });

  await t.test("dispatch-mode mapping: openwhispr is not smuggled through providers", async () => {
    setPolicy({ llmModes: ["providers"], llmByokProviders: ["openai"] });
    await assert.rejects(reasoningService.processText("hi", "", null, { provider: "openwhispr" }), {
      message: REASONING_RESTRICTED,
    });
  });

  await t.test(
    "an allowed selection passes enforcement and fails later, not on policy",
    async () => {
      setPolicy({ llmModes: ["providers"], llmByokProviders: ["openai"] });
      await assert.rejects(reasoningService.processText("hi", "", null, { provider: "openai" }), {
        message: "No reasoning model selected",
      });
    }
  );

  await t.test(
    "streaming chat rejects before any dispatch when the agent is disabled",
    async () => {
      setPolicy({ agentEnabled: false, llmModes: ["providers"], llmByokProviders: ["openai"] });
      const stream = reasoningService.processTextStreaming(
        [{ role: "user", content: "hi" }],
        "gpt-4.1",
        "openai",
        { systemPrompt: "s" }
      );
      await assert.rejects(stream.next(), { message: AGENT_RESTRICTED });
    }
  );

  await t.test("agent streaming rejects a policy-blocked provider mode", async () => {
    setPolicy({ llmModes: ["self-hosted"], llmByokProviders: [] });
    const stream = reasoningService.processTextStreamingAI(
      [{ role: "user", content: "hi" }],
      "gpt-4.1",
      "openai",
      { systemPrompt: "s" }
    );
    await assert.rejects(stream.next(), { message: REASONING_RESTRICTED });
  });

  await t.test("cloud agent streaming enforces the openwhispr mode", async () => {
    setPolicy({ llmModes: ["providers"], llmByokProviders: ["openai"] });
    const stream = reasoningService.processTextStreamingCloud([{ role: "user", content: "hi" }], {
      systemPrompt: "s",
    });
    await assert.rejects(stream.next(), { message: REASONING_RESTRICTED });
  });
});
