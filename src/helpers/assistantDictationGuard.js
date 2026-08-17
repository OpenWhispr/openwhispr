function shouldBlockNonAgentDictation({ assistantPanelOpen, voiceAgentRequested = false }) {
  return Boolean(assistantPanelOpen && !voiceAgentRequested);
}

module.exports = { shouldBlockNonAgentDictation };
