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
// not start underneath it. An idle assistant may accept a voice follow-up,
// but no recording may begin while the current request is still busy.
function shouldBlockDictationWhilePanelOpen({
  assistantPanelOpen,
  assistantPanelBusy = false,
  voiceAgentRequested = false,
}) {
  if (assistantPanelBusy) return true;
  if (!assistantPanelOpen) return false;
  return !voiceAgentRequested;
}

module.exports = {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
  shouldBlockDictationWhilePanelOpen,
};
