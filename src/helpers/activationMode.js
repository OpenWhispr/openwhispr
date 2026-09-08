// Dictation hotkey activation modes.
//
//   tap    -- a press toggles recording on/off.
//   push   -- recording runs only while the key is held.
//   hybrid -- a short tap latches recording on until the next tap; a press
//             held past HYBRID_TAP_THRESHOLD_MS records while held and stops
//             on release. The same threshold/latch behaviour as the
//             "Automatic (Both)" mode in FluidVoice, reimplemented here.
//
// Pure decisions only; the main-process key handlers own the timers and IPC.
// ESM like the other renderer-shared helpers; main-process callers require() it.

export const ACTIVATION_MODES = Object.freeze(["tap", "push", "hybrid"]);
export const HYBRID_TAP_THRESHOLD_MS = 400;

export function normalizeActivationMode(mode) {
  return mode === "push" || mode === "hybrid" ? mode : "tap";
}

// Whether the mode needs key-release events (native listeners, push plumbing).
export function usesKeyRelease(mode) {
  return normalizeActivationMode(mode) !== "tap";
}

// The hotkey-manager side only knows tap vs push; hybrid rides on push plumbing.
export function toHotkeyRegistrationMode(mode) {
  return usesKeyRelease(mode) ? "push" : "tap";
}

// What a hotkey press does, before any press state exists.
//   "toggle" -- tap mode
//   "stop"   -- hybrid with a latched recording running: this press ends it
//   "hold"   -- push/hybrid: start the press state machine
export function resolveDictationPress({ mode, isRecording = false }) {
  const normalized = normalizeActivationMode(mode);
  if (normalized === "tap") return "toggle";
  if (normalized === "hybrid" && isRecording) return "stop";
  return "hold";
}

// What the release of a tracked press does.
//   "latch"  -- hybrid tap: recording keeps running until the next press
//   "stop"   -- the press was recording: stop now
//   "cancel" -- the press never reached recording: drop the preparation
export function resolveDictationRelease({
  mode,
  heldMs,
  isRecording = false,
  force = false,
  thresholdMs = HYBRID_TAP_THRESHOLD_MS,
}) {
  const normalized = normalizeActivationMode(mode);
  if (!force && normalized === "hybrid" && heldMs < thresholdMs) return "latch";
  return isRecording ? "stop" : "cancel";
}
