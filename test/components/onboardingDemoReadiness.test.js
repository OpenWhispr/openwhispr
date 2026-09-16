const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("practice account readiness follows the inference route used by Assistant", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "onboarding-readiness-" });
  const { useSettingsStore, selectPolicyEffectiveSettings } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { resolveChatStreamingInference } = await vite.ssrLoadModule(
    "/helpers/dictationAgentInference.js"
  );
  const { getOnboardingDemoAuthStatus } = await vite.ssrLoadModule("/utils/onboardingDemo.ts");
  const local = {
    ...useSettingsStore.getState(),
    isSignedIn: false,
    useLocalWhisper: true,
    useCleanupModel: false,
    cleanupMode: "local",
    cleanupCloudMode: "openwhispr",
    useDictationAgent: true,
    dictationAgentMode: "local",
    dictationAgentProvider: "qwen",
    dictationAgentModel: "qwen3-4b-q4_k_m",
    dictationAgentCloudMode: "openwhispr",
    chatAgentMode: "self-hosted",
    chatAgentProvider: "lan",
    chatAgentModel: "qwen3-4b-q4_k_m",
    chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
  };
  const signedOut = { isLoaded: true, isSignedIn: false };
  const unresolved = { isLoaded: false, isSignedIn: false };
  const signedIn = { isLoaded: true, isSignedIn: true };
  const unverified = { ...signedIn, emailVerified: false };
  const pending = {
    ...signedIn,
    emailVerified: true,
    pendingVerificationEmail: "new@example.test",
  };
  const cloudChat = { chatAgentMode: "openwhispr", chatAgentCloudMode: "openwhispr" };
  const cloudAssistant = {
    dictationAgentMode: "openwhispr",
    dictationAgentCloudMode: "openwhispr",
  };

  for (const scenario of [
    {
      name: "a disabled Assistant with stale Cloud settings uses local Chat",
      settings: { ...local, ...cloudAssistant, useDictationAgent: false },
      scope: "chatIntelligence",
      mode: "self-hosted",
    },
    {
      name: "unconfigured BYOK Assistant uses local Chat",
      settings: { ...local, dictationAgentMode: "providers", dictationAgentModel: "" },
      scope: "chatIntelligence",
      mode: "self-hosted",
    },
    {
      name: "a configured local Assistant does not require its unused Cloud Chat account",
      settings: { ...local, ...cloudChat },
      scope: "dictationAgent",
      mode: "local",
    },
    {
      name: "a signed-out Cloud Assistant falls back to local Chat",
      settings: { ...local, ...cloudAssistant },
      scope: "chatIntelligence",
      mode: "self-hosted",
    },
    {
      name: "a configured BYOK Assistant does not require an OpenWhispr account",
      settings: {
        ...local,
        ...cloudChat,
        dictationAgentMode: "providers",
        dictationAgentProvider: "openai",
        dictationAgentModel: "gpt-5-mini",
      },
      scope: "dictationAgent",
      mode: "providers",
    },
  ]) {
    await t.test(scenario.name, () => {
      const { config } = resolveChatStreamingInference(scenario.settings, {
        inferenceScope: "dictationAgent",
      });
      assert.equal(config.scope, scenario.scope);
      assert.equal(config.mode, scenario.mode);
      assert.equal(getOnboardingDemoAuthStatus("assistant", scenario.settings, signedOut), "ready");
      assert.equal(
        getOnboardingDemoAuthStatus("assistant", scenario.settings, unresolved),
        "ready"
      );
      for (const auth of [unverified, pending]) {
        assert.equal(getOnboardingDemoAuthStatus("assistant", scenario.settings, auth), "ready");
      }
    });
  }

  await t.test("an unreachable Assistant gates the Cloud Chat route on account readiness", () => {
    for (const auth of [unresolved, signedOut, signedIn]) {
      const settings = {
        ...local,
        ...cloudChat,
        isSignedIn: auth.isSignedIn,
        dictationAgentModel: "",
      };
      const { config } = resolveChatStreamingInference(settings, {
        inferenceScope: "dictationAgent",
      });
      assert.equal(config.scope, "chatIntelligence");
      assert.equal(config.mode, "openwhispr");
      assert.equal(
        getOnboardingDemoAuthStatus("assistant", settings, auth),
        !auth.isLoaded ? "loading" : auth.isSignedIn ? "ready" : "required"
      );
    }
  });

  await t.test(
    "policy-effective Cloud routing requires its account even with local saved choices",
    () => {
      const effective = selectPolicyEffectiveSettings(local, {
        status: "managed",
        policy: {
          version: 1,
          transcription: { allowedModes: ["local"], allowedByokProviders: [] },
          llm: {
            allowedModes: ["openwhispr"],
            allowedByokProviders: [],
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
      assert.equal(local.dictationAgentMode, "local");
      assert.equal(effective.useLocalWhisper, true);
      assert.equal(
        resolveChatStreamingInference(effective, { inferenceScope: "dictationAgent" }).config.mode,
        "openwhispr"
      );
      assert.equal(getOnboardingDemoAuthStatus("assistant", effective, signedOut), "required");
      assert.equal(getOnboardingDemoAuthStatus("assistant", effective, unverified), "required");
      assert.equal(getOnboardingDemoAuthStatus("assistant", effective, pending), "required");
    }
  );

  await t.test(
    "Cloud transcription still gates both demos, while BYOK transcription does not",
    () => {
      for (const kind of ["dictation", "assistant"]) {
        const cloud = { ...local, useLocalWhisper: false, cloudTranscriptionMode: "openwhispr" };
        assert.equal(getOnboardingDemoAuthStatus(kind, cloud, unresolved), "loading");
        assert.equal(getOnboardingDemoAuthStatus(kind, cloud, signedOut), "required");
        assert.equal(getOnboardingDemoAuthStatus(kind, cloud, signedIn), "ready");
        assert.equal(getOnboardingDemoAuthStatus(kind, cloud, unverified), "required");
        assert.equal(getOnboardingDemoAuthStatus(kind, cloud, pending), "required");
        assert.equal(
          getOnboardingDemoAuthStatus(kind, cloud, { ...pending, isLoaded: false }),
          "loading"
        );
        assert.equal(
          getOnboardingDemoAuthStatus(kind, cloud, { ...signedIn, emailVerified: true }),
          "ready"
        );
        assert.equal(
          getOnboardingDemoAuthStatus(
            kind,
            { ...cloud, cloudTranscriptionMode: "byok" },
            signedOut
          ),
          "ready"
        );
      }
    }
  );

  await t.test(
    "Dictation cleanup still requires its account only when Cloud cleanup is enabled",
    () => {
      const cloud = { ...local, useCleanupModel: true, cleanupMode: "openwhispr" };
      assert.equal(getOnboardingDemoAuthStatus("dictation", cloud, unresolved), "loading");
      assert.equal(getOnboardingDemoAuthStatus("dictation", cloud, signedOut), "required");
      assert.equal(getOnboardingDemoAuthStatus("dictation", cloud, signedIn), "ready");
      for (const settings of [
        local,
        { ...cloud, useCleanupModel: false },
        { ...cloud, cleanupMode: "providers" },
        { ...cloud, cleanupCloudMode: "byok" },
      ]) {
        assert.equal(getOnboardingDemoAuthStatus("dictation", settings, signedOut), "ready");
      }
    }
  );
});
