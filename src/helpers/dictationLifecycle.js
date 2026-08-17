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

module.exports = {
  DICTATION_LIFECYCLE,
  normalizeDictationLifecycle,
  shouldIgnoreDictationHotkey,
  isDictationRecording,
};
