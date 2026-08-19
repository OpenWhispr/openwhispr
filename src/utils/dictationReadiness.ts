/**
 * Single owner of the "may a new dictation start?" guard over AudioManager's
 * getState() snapshot. Three call sites in useAudioRecording.js (the hotkey
 * toggle, performStartRecording, and the hover-prepare handler) used to carry
 * hand-copied flag lists that drifted: hover-prepare had lost the two
 * streaming transition flags, so only AudioManager's internal stop promise
 * kept a prepare from racing a streaming start/finalize. Pure module so the
 * flag set is unit-testable (test/utils/dictationReadiness.test.js).
 */
export interface DictationReadinessState {
  isRecording?: boolean;
  isProcessing?: boolean;
  isStreaming?: boolean;
  isStreamingStartInProgress?: boolean;
  isFinalizingStreaming?: boolean;
}

export function canStartDictation(state: DictationReadinessState | null | undefined): boolean {
  if (!state) return false;
  return !(
    state.isRecording ||
    state.isProcessing ||
    state.isStreaming ||
    state.isStreamingStartInProgress ||
    state.isFinalizingStreaming
  );
}
