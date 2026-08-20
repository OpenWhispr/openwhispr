/**
 * Resolves the durable portion of an Assistant panel session when its surface
 * closes. Conversation identity survives only in renderer memory; in-flight
 * presentation and command state must not leak into the next open.
 */
export function closeAssistantSessionState(state) {
  return {
    conversationId: state.conversationId ?? null,
    pendingCommand: null,
    thinking: false,
    busy: false,
    responseReady: false,
  };
}

export function resolveAssistantPanelBusy({ agentState, activeToolName, submissionInFlight }) {
  return Boolean(
    submissionInFlight ||
    activeToolName ||
    agentState === "thinking" ||
    agentState === "streaming" ||
    agentState === "tool-executing"
  );
}

export function discardPendingAssistantCommand(pendingCommand, commandId) {
  return pendingCommand?.id === commandId ? null : pendingCommand;
}

export async function restoreAssistantConversation({
  conversationId,
  loadConversation,
  onReady,
  onReset,
  onError,
  isActive = () => true,
}) {
  try {
    await loadConversation(conversationId);
    if (!isActive()) return "inactive";
    onReady();
    return "restored";
  } catch (error) {
    if (!isActive()) return "inactive";
    onError(error);
    onReset();
    onReady();
    return "reset";
  }
}
