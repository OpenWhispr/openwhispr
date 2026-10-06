const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
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
  const vite = await createRendererServer(t, {
    cachePrefix,
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const store = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const inference = await vite.ssrLoadModule("/helpers/dictationAgentInference.js");
  return { ...store, ...inference, vite };
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

test("a forbidden vision mode cannot redirect a local assistant to Cloud", async (t) => {
  const { useSettingsStore, selectPolicyEffectiveSettings, resolveChatStreamingInference } =
    await loadStore(
      t,
      {
        ...unconfiguredOverride,
        dictationAgentMode: "local",
        dictationAgentProvider: "qwen",
        dictationAgentModel: "qwen3-4b-q4_k_m",
        dictationAgentVisionProvider: "gemini",
        dictationAgentVisionModel: "gemini-2.5-flash",
      },
      "openwhispr-policy-vision-mode-test-"
    );
  const raw = { ...useSettingsStore.getState(), isSignedIn: true };
  const policy = managedByokPolicy([]);
  policy.policy.llm.allowedModes = ["openwhispr", "local"];
  const effective = selectPolicyEffectiveSettings(raw, policy);
  const result = resolveChatStreamingInference(effective, {
    inferenceScope: "dictationAgent",
    hasScreenContext: true,
    isProviderImageWired: (provider) => ["openwhispr", "gemini"].includes(provider),
  });

  assert.equal(result.config.scope, "dictationAgent");
  assert.equal(result.config.mode, "local");
  assert.equal(result.attachScreenContext, false);
  assert.equal(effective.dictationAgentVisionModel, "");
  assert.equal(raw.dictationAgentVisionModel, "gemini-2.5-flash");

  const restored = selectPolicyEffectiveSettings(raw, managedByokPolicy(["gemini"]));
  const restoredResult = resolveChatStreamingInference(restored, {
    inferenceScope: "dictationAgent",
    hasScreenContext: true,
    isProviderImageWired: (provider) => provider === "gemini",
  });
  assert.equal(restoredResult.config.scope, "dictationAgentVision");
  assert.equal(restoredResult.config.provider, "gemini");
  assert.equal(restoredResult.config.model, "gemini-2.5-flash");
  assert.equal(restoredResult.attachScreenContext, true);
});

test("the vision picker shows no Active model after policy clears its selection", async (t) => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { vite } = await loadStore(
    t,
    {
      ...unconfiguredOverride,
      dictationAgentMode: "providers",
      dictationAgentProvider: "openai",
      dictationAgentModel: "gpt-5-mini",
      dictationAgentVisionProvider: "gemini",
      dictationAgentVisionModel: "gemini-2.5-flash",
    },
    "openwhispr-policy-vision-picker-test-"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  // Server rendering reads Zustand's initial snapshot rather than getState().
  Object.assign(usePolicyStore.getInitialState(), managedByokPolicy(["openai"]));
  const { default: InferenceConfigEditor } = await vite.ssrLoadModule(
    "/components/settings/InferenceConfigEditor.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  const renderEditor = (scope) =>
    renderToStaticMarkup(
      React.createElement(InferenceConfigEditor, { scope, allowedModes: ["providers"] })
    );

  const visionMarkup = renderEditor("dictationAgentVision");
  assert.ok(visionMarkup.includes("GPT-5 Mini"), "the model list is actually rendered");
  assert.ok(!visionMarkup.includes(`>${i18n.t("common.active")}<`));
  assert.ok(renderEditor("dictationAgent").includes(`>${i18n.t("common.active")}<`));
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
