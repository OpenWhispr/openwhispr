/**
 * Resolve only the active voice presentation. Idle/hover styling remains owned
 * by App because it also depends on pointer and microphone availability state.
 */
export function resolveVoiceActivityPresentation({
  isRecording,
  isProcessing,
  isAssistantVoice,
  assistantThinking,
}) {
  if (isRecording) {
    return { activeState: "recording", compactPill: true, isAgentThinking: false };
  }

  if (assistantThinking || (isAssistantVoice && isProcessing)) {
    return { activeState: "thinking", compactPill: false, isAgentThinking: true };
  }

  if (isProcessing) {
    return { activeState: "thinking", compactPill: false, isAgentThinking: false };
  }

  return { activeState: null, compactPill: false, isAgentThinking: false };
}

/**
 * A fresh request thinks in the floating logo circle. A follow-up that starts
 * from an open response panel keeps that surface mounted so its footer pill
 * can own the thinking feedback without a close/reopen transition.
 */
export function resolveAssistantThinkingTransition(panelOpen) {
  return {
    panelOpen: Boolean(panelOpen),
    panelMounted: true,
    responseReady: false,
    thinking: true,
  };
}
