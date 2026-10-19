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

function shouldIgnoreDictationHotkey(state) {
  return normalizeDictationLifecycle(state) === DICTATION_LIFECYCLE.PROCESSING;
}

function isDictationRecording(state) {
  return normalizeDictationLifecycle(state) === DICTATION_LIFECYCLE.RECORDING;
}

module.exports = {
  DICTATION_LIFECYCLE,
  DICTATION_INPUT_KIND,
  normalizeDictationLifecycle,
  normalizeDictationInputKind,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
};
