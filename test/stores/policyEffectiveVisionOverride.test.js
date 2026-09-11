const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// A managed org that permits BYOK. In v1.10.0 the policy overlay treated the
// never-configured vision override like any other BYOK scope and handed it the
// first allowed provider plus that provider's default model, which switched the
// override on and sent every screenshot command to OpenAI with no key.
const managedByokPolicy = (allowedByokProviders) => ({
  status: "managed",
  appVersion: "1.10.0",
  policy: {
    version: 1,
    transcription: {
      allowedModes: ["openwhispr", "providers", "local", "self-hosted"],
      allowedByokProviders: ["openai"],
    },
    llm: {
      allowedModes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"],
      allowedByokProviders,
      allowedEnterpriseProviders: [],
    },
    features: { agentEnabled: true, webSearchEnabled: true, screenContextEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

// Assistant on OpenWhispr Cloud, screen context on, "Separate vision model"
// switched on but never given a provider or model.
const unconfiguredOverride = {
  _llmScopeKeysMigrated: "1",
  _dictationAgentSeeded: "1",
  dictationAgentMode: "openwhispr",
  dictationAgentCloudMode: "openwhispr",
  voiceAgentScreenContext: "true",
  useDictationAgentVisionModel: "true",
};

async function loadStore(t, initialStorage, cachePrefix) {
  installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t, { cachePrefix });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const inference = await vite.ssrLoadModule("/helpers/dictationAgentInference.js");
  return { ...store, ...inference };
}

test("a managed policy never invents a target for an unconfigured vision override", async (t) => {
  const { useSettingsStore, selectPolicyEffectiveSettings, resolveChatStreamingInference } =
    await loadStore(t, unconfiguredOverride, "openwhispr-policy-vision-unconfigured-test-");
  const raw = useSettingsStore.getState();
  assert.equal(raw.dictationAgentVisionModel, "", "precondition: nothing chosen");

  const effective = selectPolicyEffectiveSettings(
    { ...raw, isSignedIn: true },
    managedByokPolicy(["openai", "anthropic", "gemini"])
  );

  await t.test("the override keeps no provider or model", () => {
    assert.equal(effective.dictationAgentVisionProvider, "");
    assert.equal(effective.dictationAgentVisionModel, "");
  });

  await t.test("a screenshot command stays on the cloud with its screenshot", () => {
    const { config, attachScreenContext } = resolveChatStreamingInference(effective, {
      inferenceScope: "dictationAgent",
      hasScreenContext: true,
      isProviderImageWired: () => true,
    });

    assert.equal(config.scope, "dictationAgent");
    assert.equal(config.mode, "openwhispr");
    assert.equal(attachScreenContext, true);
  });
});

test("a policy that moves a configured override's provider clears its model", async (t) => {
  const { useSettingsStore, selectPolicyEffectiveSettings, resolveChatStreamingInference } =
    await loadStore(
      t,
      {
        ...unconfiguredOverride,
        dictationAgentMode: "providers",
        dictationAgentProvider: "anthropic",
        dictationAgentModel: "claude-sonnet-4-5",
        dictationAgentVisionProvider: "gemini",
        dictationAgentVisionModel: "gemini-2.5-flash",
      },
      "openwhispr-policy-vision-clamped-test-"
    );

  // Anthropic stays allowed, so the assistant itself is untouched; only the
  // override's Gemini choice is outside the policy.
  const effective = selectPolicyEffectiveSettings(
    useSettingsStore.getState(),
    managedByokPolicy(["openai", "anthropic"])
  );

  await t.test("the picker lands on the allowed provider with nothing chosen", () => {
    assert.equal(effective.dictationAgentVisionProvider, "openai");
    assert.equal(effective.dictationAgentVisionModel, "");
  });

  await t.test("the override goes inert instead of routing to a keyless default", () => {
    const { config } = resolveChatStreamingInference(effective, {
      inferenceScope: "dictationAgent",
      hasScreenContext: true,
      isProviderImageWired: () => true,
    });

    assert.equal(config.scope, "dictationAgent");
    assert.equal(config.provider, "anthropic");
  });
});
