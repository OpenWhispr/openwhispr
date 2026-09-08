const DICTATION_LIFECYCLE = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  RECORDING: "recording",
  PROCESSING: "processing",
});

const DICTATION_INPUT_KIND = Object.freeze({
  DICTATION: "dictation",
  ASSISTANT: "assistant",
  TRANSLATION: "translation",
});

const VALID_STATES = new Set(Object.values(DICTATION_LIFECYCLE));
const VALID_INPUT_KINDS = new Set(Object.values(DICTATION_INPUT_KIND));

function normalizeDictationLifecycle(state) {
  return VALID_STATES.has(state) ? state : DICTATION_LIFECYCLE.IDLE;
}

function normalizeDictationInputKind(inputKind) {
  return VALID_INPUT_KINDS.has(inputKind) ? inputKind : DICTATION_INPUT_KIND.DICTATION;
}

function resolveAgentDictationPillState(state, inputKind) {
  const lifecycle = normalizeDictationLifecycle(state);
  const normalizedInputKind = normalizeDictationInputKind(inputKind);
  const ownsLifecycle =
    lifecycle === DICTATION_LIFECYCLE.IDLE ||
    normalizedInputKind === DICTATION_INPUT_KIND.DICTATION;

  return {
    lifecycle: ownsLifecycle ? lifecycle : DICTATION_LIFECYCLE.IDLE,
    interactive: ownsLifecycle,
  };
}

function shouldIgnoreDictationHotkey(state) {
  return normalizeDictationLifecycle(state) === DICTATION_LIFECYCLE.PROCESSING;
}

function isDictationRecording(state) {
  return normalizeDictationLifecycle(state) === DICTATION_LIFECYCLE.RECORDING;
}

function shouldBlockDictationWhilePanelOpen({
  assistantPanelOpen,
  assistantPanelBusy = false,
  inputKind = "dictation",
  companionAvailable = true,
}) {
  // Plain dictation renders on the opposite-edge companion pill, which only
  // exists while the panel is open. A busy assistant that has not opened its
  // panel yet (the pre-open thinking flourish) leaves no surface that could
  // show the recording, so plain dictation stays blocked for that window.
  // The open panel hands those visuals to the companion, so a companion that
  // is not live yet (still loading, or its load failed) leaves the recording
  // equally invisible — fail closed until it comes back.
  if (inputKind === "dictation") {
    if (assistantPanelBusy && !assistantPanelOpen) return true;
    return assistantPanelOpen && !companionAvailable;
  }
  if (assistantPanelBusy) return true;
  if (!assistantPanelOpen) return false;
  return inputKind !== "assistant";
}

module.exports = {
  DICTATION_LIFECYCLE,
  DICTATION_INPUT_KIND,
  normalizeDictationLifecycle,
  normalizeDictationInputKind,
  resolveAgentDictationPillState,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
  shouldBlockDictationWhilePanelOpen,
};
