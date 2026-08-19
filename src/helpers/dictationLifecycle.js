const DICTATION_LIFECYCLE = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  PROCESSING: "processing",
});

const VALID_STATES = new Set(Object.values(DICTATION_LIFECYCLE));

function normalizeDictationLifecycle(state) {
  return VALID_STATES.has(state) ? state : DICTATION_LIFECYCLE.IDLE;
}

function shouldIgnoreDictationHotkey(state) {
  return normalizeDictationLifecycle(state) === DICTATION_LIFECYCLE.PROCESSING;
}

function isDictationRecording(state) {
  return normalizeDictationLifecycle(state) === DICTATION_LIFECYCLE.RECORDING;
}

// While the assistant panel owns the shared pill window, plain dictation must
// not start underneath it — only a voice-assistant request may record an
// in-panel follow-up.
function shouldBlockDictationWhilePanelOpen({ assistantPanelOpen, voiceAgentRequested = false }) {
  return Boolean(assistantPanelOpen && !voiceAgentRequested);
}

module.exports = {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
  shouldBlockDictationWhilePanelOpen,
};
