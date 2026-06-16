// Decides which reasoning path ("agent" | "cleanup" | "skip") a finished
// dictation takes. A recording started via the voice agent hotkey always takes
// the agent path — no wake word needed — and never falls back to cleanup.
export function resolveDictationRouteKind({
  cleanupReachable,
  agentReachable,
  agentInvoked,
  voiceAgentRequested,
}) {
  if (voiceAgentRequested) {
    return agentReachable ? "agent" : "skip";
  }
  if (agentReachable && agentInvoked) {
    return "agent";
  }
  if (cleanupReachable) {
    return "cleanup";
  }
  return "skip";
}
