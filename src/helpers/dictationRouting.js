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

// Decides what to do with a captured screenshot on the agent route. A
// configured vision override is trusted (required for custom/OpenRouter ids
// the registry doesn't know) but never silently swapped for the base model
// when unusable — the image is dropped instead. Without an override, the base
// model gets the image only when its provider client is image-wired and the
// model is known vision-capable (cloud mode defers that check to the server).
// Dropping the image always beats failing the dictation.
export function resolveAgentImageTarget({
  hasScreenContext,
  visionOverrideEnabled,
  visionReachable,
  visionProviderImageWired,
  baseProviderImageWired,
  isCloudAgent,
  baseModelSupportsVision,
}) {
  if (!hasScreenContext) {
    return { attach: false, useVisionOverride: false };
  }
  if (visionOverrideEnabled) {
    return visionReachable && visionProviderImageWired
      ? { attach: true, useVisionOverride: true }
      : { attach: false, useVisionOverride: false };
  }
  if (baseProviderImageWired && (isCloudAgent || baseModelSupportsVision)) {
    return { attach: true, useVisionOverride: false };
  }
  return { attach: false, useVisionOverride: false };
}

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
