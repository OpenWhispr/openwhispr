export function resolveModeReachability({ mode, provider, model, isCloud, isSelfHosted }) {
  if (mode === "openwhispr") return isCloud;
  if (mode === "self-hosted") return isSelfHosted;

  const hasModel = (model?.trim()?.length ?? 0) > 0;
  if (mode === "local") return hasModel;
  if (mode === "providers" || mode === "enterprise") {
    return !!provider?.trim() && hasModel;
  }
  return false;
}

export function resolveDictationAgentReachability({
  useDictationAgent,
  dictationAgentMode,
  dictationAgentProvider,
  dictationAgentModel,
  isCloudAgent,
  isSelfHostedAgent,
}) {
  if (!useDictationAgent) return false;
  return resolveModeReachability({
    mode: dictationAgentMode,
    provider: dictationAgentProvider,
    model: dictationAgentModel,
    isCloud: isCloudAgent,
    isSelfHosted: isSelfHostedAgent,
  });
}

// Picks which model receives a captured screenshot, or drops it. An
// explicitly configured vision override is trusted without a capability check
// (custom and OpenRouter model ids aren't in the registry); an override that
// is toggled on but never configured inherits the agent's own config, so it
// falls through to the base rules rather than forcing an image onto a
// possibly text-only model. Dropping the image always beats failing the
// dictation.
export function resolveAgentImageTarget({
  hasScreenContext,
  visionOverrideActive,
  visionProviderImageWired,
  baseProviderImageWired,
  isCloudAgent,
  baseModelSupportsVision,
}) {
  if (!hasScreenContext) {
    return { attach: false, useVisionOverride: false };
  }
  if (visionOverrideActive) {
    // Configured but unable to send images: drop rather than quietly
    // redirecting the screenshot to a model the user didn't choose.
    return visionProviderImageWired
      ? { attach: true, useVisionOverride: true }
      : { attach: false, useVisionOverride: false };
  }
  // Cloud defers the vision-model choice to the server's vision chain.
  if (baseProviderImageWired && (isCloudAgent || baseModelSupportsVision)) {
    return { attach: true, useVisionOverride: false };
  }
  return { attach: false, useVisionOverride: false };
}

// Decides which reasoning path ("agent" | "cleanup" | "skip") a finished
// dictation takes. A recording started via the voice agent hotkey always takes
// the agent path — no wake word needed — and never falls back to cleanup.
export function resolveDictationTranslationReachability({
  useDictationTranslation,
  translationTargetLanguage,
  translationMode,
  translationProvider,
  translationModel,
  isCloudTranslation,
  isSelfHostedTranslation,
}) {
  if (!useDictationTranslation) return false;
  if (!translationTargetLanguage?.trim()) return false;
  return resolveModeReachability({
    mode: translationMode,
    provider: translationProvider,
    model: translationModel,
    isCloud: isCloudTranslation,
    isSelfHosted: isSelfHostedTranslation,
  });
}

export function resolveModeProvider({ isCloud, mode, provider }) {
  switch (mode) {
    case "openwhispr":
      return isCloud ? "openwhispr" : undefined;
    case "local":
      return "local";
    case "self-hosted":
      return undefined;
    case "providers":
    case "enterprise":
      return provider?.trim() || undefined;
    default:
      return undefined;
  }
}

export function resolveDictationAgentProvider({
  isCloudAgent,
  dictationAgentMode,
  dictationAgentProvider,
}) {
  return resolveModeProvider({
    isCloud: isCloudAgent,
    mode: dictationAgentMode,
    provider: dictationAgentProvider,
  });
}

function resolveModeDisplayProvider(mode, provider) {
  if (mode === "openwhispr") return "openwhispr";
  if (mode === "local") return "local";
  if (mode === "self-hosted") return "self-hosted";
  return provider?.trim() || "none";
}

export function resolveDictationAgentDisplayProvider({
  dictationAgentMode,
  dictationAgentProvider,
}) {
  return resolveModeDisplayProvider(dictationAgentMode, dictationAgentProvider);
}

export function resolveTranslationProviderId({
  isCloudTranslation,
  translationMode,
  translationProvider,
}) {
  return resolveModeProvider({
    isCloud: isCloudTranslation,
    mode: translationMode,
    provider: translationProvider,
  });
}

export function resolveTranslationDisplayProvider({ translationMode, translationProvider }) {
  return resolveModeDisplayProvider(translationMode, translationProvider);
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
