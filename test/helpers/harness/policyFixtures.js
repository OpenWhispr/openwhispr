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

module.exports = { managedPolicy };
