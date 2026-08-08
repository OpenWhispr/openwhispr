const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const managedPolicy = {
  version: 1,
  transcription: {
    allowedModes: ["local"],
    allowedByokProviders: [],
  },
  llm: {
    allowedModes: ["enterprise"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["bedrock"],
  },
  features: { agentEnabled: true, webSearchEnabled: true },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
};

test("runtime settings use managed fallbacks without overwriting raw preferences", async (t) => {
  const browser = installBrowserGlobals(t, {
    initialStorage: {
      transcriptionMode: "providers",
      useLocalWhisper: "false",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "groq",
      cleanupMode: "providers",
      cleanupCloudMode: "byok",
      cleanupProvider: "openai",
      cleanupModel: "gpt-5.6-sol",
      bedrockRegion: "eu-west-2",
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-effective-settings-test-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { isLlmSelectionAllowed, isTranscriptionContextAllowed } =
    await vite.ssrLoadModule("/stores/policyRules.ts");
  const { getSettings, useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");

  usePolicyStore.setState({
    status: "managed",
    managed: true,
    policy: managedPolicy,
    appVersion: "1.8.1",
  });

  const effective = getSettings();
  assert.equal(effective.transcriptionMode, "local");
  assert.equal(effective.useLocalWhisper, true);
  assert.equal(effective.cleanupMode, "enterprise");
  assert.equal(effective.cleanupProvider, "bedrock");
  assert.ok(effective.cleanupModel);
  assert.match(effective.cleanupModel, /^eu\./);
  assert.equal(
    isTranscriptionContextAllowed(usePolicyStore.getState(), effective, "dictation"),
    true
  );
  assert.equal(
    isLlmSelectionAllowed(usePolicyStore.getState(), {
      mode: effective.cleanupMode,
      provider: effective.cleanupProvider,
    }),
    true
  );

  const raw = useSettingsStore.getState();
  assert.equal(raw.transcriptionMode, "providers");
  assert.equal(raw.useLocalWhisper, false);
  assert.equal(raw.cleanupMode, "providers");
  assert.equal(raw.cleanupProvider, "openai");
  assert.equal(browser.storage.getItem("transcriptionMode"), "providers");
  assert.equal(browser.storage.getItem("cleanupProvider"), "openai");

  usePolicyStore.setState({
    status: "unmanaged",
    managed: false,
    policy: null,
    appVersion: "1.8.1",
  });

  const unmanaged = getSettings();
  assert.equal(unmanaged.transcriptionMode, "providers");
  assert.equal(unmanaged.useLocalWhisper, false);
  assert.equal(unmanaged.cloudTranscriptionProvider, "groq");
});

test("managed transcription fallback binds known providers to their canonical endpoint", async (t) => {
  const customEndpoint = "https://custom.example.invalid/v1";
  installBrowserGlobals(t, {
    initialStorage: {
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "custom-model",
      cloudTranscriptionBaseUrl: customEndpoint,
      meetingTranscriptionMode: "providers",
      meetingCloudTranscriptionProvider: "custom",
      meetingCloudTranscriptionModel: "custom-model",
      meetingCloudTranscriptionBaseUrl: customEndpoint,
      uploadTranscriptionMode: "providers",
      uploadCloudTranscriptionProvider: "custom",
      uploadCloudTranscriptionModel: "custom-model",
      uploadCloudTranscriptionBaseUrl: customEndpoint,
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-effective-endpoint-test-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getSettings, useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const registry = await vite.ssrLoadModule("/models/modelRegistryData.json");
  const openai = registry.default.transcriptionProviders.find(
    (provider) => provider.id === "openai"
  );
  const providerPolicy = {
    ...managedPolicy,
    transcription: {
      allowedModes: ["providers"],
      allowedByokProviders: ["openai"],
    },
  };

  usePolicyStore.setState({
    status: "managed",
    managed: true,
    policy: providerPolicy,
    appVersion: "1.8.1",
  });

  const effective = getSettings();
  assert.equal(effective.cloudTranscriptionProvider, "openai");
  assert.equal(effective.cloudTranscriptionBaseUrl, openai.baseUrl);
  assert.equal(effective.cloudTranscriptionModel, openai.models[0].id);
  assert.equal(effective.meetingCloudTranscriptionProvider, "openai");
  assert.equal(effective.meetingCloudTranscriptionBaseUrl, openai.baseUrl);
  assert.equal(effective.uploadCloudTranscriptionProvider, "openai");
  assert.equal(effective.uploadCloudTranscriptionBaseUrl, openai.baseUrl);

  const raw = useSettingsStore.getState();
  assert.equal(raw.cloudTranscriptionProvider, "custom");
  assert.equal(raw.cloudTranscriptionBaseUrl, customEndpoint);
  assert.equal(raw.meetingCloudTranscriptionBaseUrl, customEndpoint);
  assert.equal(raw.uploadCloudTranscriptionBaseUrl, customEndpoint);
});

test("automatic Custom fallbacks never inherit another provider's endpoint", async (t) => {
  const unrelatedEndpoint = "https://unrelated.example.invalid/v1";
  installBrowserGlobals(t, {
    initialStorage: {
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionBaseUrl: unrelatedEndpoint,
      cleanupMode: "providers",
      cleanupProvider: "openai",
      cleanupCloudBaseUrl: unrelatedEndpoint,
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-policy-effective-custom-endpoint-test-",
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { getSettings, useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const customOnlyPolicy = {
    ...managedPolicy,
    transcription: {
      allowedModes: ["providers"],
      allowedByokProviders: ["custom"],
    },
    llm: {
      allowedModes: ["providers"],
      allowedByokProviders: ["custom"],
      allowedEnterpriseProviders: [],
    },
  };

  usePolicyStore.setState({
    status: "managed",
    managed: true,
    policy: customOnlyPolicy,
    appVersion: "1.8.1",
  });

  const effective = getSettings();
  assert.equal(effective.cloudTranscriptionProvider, "custom");
  assert.equal(effective.cloudTranscriptionBaseUrl, "");
  assert.equal(effective.cleanupProvider, "custom");
  assert.equal(effective.cleanupCloudBaseUrl, "");

  const raw = useSettingsStore.getState();
  assert.equal(raw.cloudTranscriptionProvider, "openai");
  assert.equal(raw.cloudTranscriptionBaseUrl, unrelatedEndpoint);
  assert.equal(raw.cleanupProvider, "openai");
  assert.equal(raw.cleanupCloudBaseUrl, unrelatedEndpoint);
});
