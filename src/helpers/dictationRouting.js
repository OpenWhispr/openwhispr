// Whether the dictation agent can actually run. Mirrors ReasoningService.processText,
// which accepts an empty model only for the cloud ("openwhispr") and self-hosted ("lan")
// providers; every other mode (BYOK, local, enterprise) requires an explicit model.
export function resolveDictationAgentReachability({
  useDictationAgent,
  dictationAgentModel,
  isCloudAgent,
  isSelfHostedAgent,
}) {
  if (!useDictationAgent) return false;
  if (isCloudAgent || isSelfHostedAgent) return true;
  return (dictationAgentModel?.trim()?.length ?? 0) > 0;
}

// Whether the translation step can run: cloud/self-hosted accept an empty model,
// every other mode requires one; a target language is always required.
export function resolveDictationTranslationReachability({
  useDictationTranslation,
  translationTargetLanguage,
  translationModel,
  isCloudTranslation,
  isSelfHostedTranslation,
}) {
  if (!useDictationTranslation) return false;
  if (!translationTargetLanguage?.trim()) return false;
  if (isCloudTranslation || isSelfHostedTranslation) return true;
  return (translationModel?.trim()?.length ?? 0) > 0;
}

// Decides which reasoning path ("translation" | "agent" | "cleanup" | "skip")
// a finished dictation takes. A recording started via the voice agent hotkey
// always takes the agent path — no wake word needed — and never falls back to
// cleanup. A translation recording degrades to cleanup instead: the transcript
// is still a useful dictation without the translation step.
export function resolveDictationRouteKind({
  cleanupReachable,
  agentReachable,
  agentInvoked,
  voiceAgentRequested,
  translationRequested,
  translationReachable,
}) {
  if (translationRequested) {
    if (translationReachable) return "translation";
    return cleanupReachable ? "cleanup" : "skip";
  }
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
