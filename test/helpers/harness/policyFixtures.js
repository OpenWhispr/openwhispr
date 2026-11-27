// A managed workspace policy in the shape policyStore applies, with every section
// closed off unless the test opens it.
function managedPolicy({ transcription = {}, llm = {} } = {}) {
  return {
    version: 1,
    transcription: {
      allowedModes: [],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
      ...transcription,
    },
    llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [], ...llm },
    features: { agentEnabled: false, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  };
}

// The provider publishes this model through the live catalog.
async function loadAssemblyAiDictationCatalog(vite) {
  const registry = await vite.ssrLoadModule("/models/registryData.js");
  const { data, manifestVersion } = registry.getRegistrySnapshot();
  const { models } = data.transcriptionProviders.find((provider) => provider.id === "assemblyai");
  if (!models.some((model) => model.id === "dictation")) {
    models.push({ id: "dictation", name: "Dictation", description: "Dictation with rewrite" });
    registry.replaceRegistryData({ data, manifestVersion: manifestVersion + 1 });
  }
}

function assemblyAiPolicy(sttAllowed, llmAllowed) {
  const permissions = (allowed) => ({
    allowedModes: ["providers"],
    allowedByokProviders: allowed ? ["assemblyai"] : [],
  });
  return {
    status: "managed",
    appVersion: "1.11.1",
    policy: managedPolicy({ transcription: permissions(sttAllowed), llm: permissions(llmAllowed) }),
  };
}

// The workspace owns cleanup while members still select their own transcription provider.
async function setManagedBedrockCleanup(vite, mode = "managed_required") {
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { policy } = usePolicyStore.getState();
  usePolicyStore.setState({
    policy: {
      ...policy,
      llm: {
        ...policy.llm,
        allowedModes: ["providers", "enterprise"],
        allowedEnterpriseProviders: ["bedrock"],
      },
    },
  });
  useEnterpriseIdentityStore.setState({
    status: "ready",
    accountId: "account",
    workspaceId: "workspace",
    authGeneration: 1,
    config: {
      generation: 1,
      providers: [
        {
          provider: "bedrock",
          mode,
          allowManualSetup: mode === "managed_default",
          config: { scopeDefaults: { dictationCleanup: "managed-model" } },
        },
      ],
    },
  });
}

module.exports = {
  managedPolicy,
  loadAssemblyAiDictationCatalog,
  assemblyAiPolicy,
  setManagedBedrockCleanup,
};
