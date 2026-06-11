// Decides which reasoning path a finished dictation takes:
// - "agent": send the transcript to the dictation agent as a command
// - "cleanup": send the transcript to the cleanup model
// - "skip": return the raw transcript untouched
//
// A recording started via the voice agent hotkey forces the agent path —
// no wake word needed — and never falls back to cleanup.
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
