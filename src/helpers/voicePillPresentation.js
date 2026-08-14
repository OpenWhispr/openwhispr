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
    return { activeState: "processing", compactPill: true, isAgentThinking: false };
  }

  return { activeState: null, compactPill: false, isAgentThinking: false };
}
