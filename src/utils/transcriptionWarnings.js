export const CLEANUP_FAILED_WARNING = "cleanup_failed";

export function createCleanupFailedWarning({ stage = "cleanup", provider } = {}) {
  const warning = {
    type: CLEANUP_FAILED_WARNING,
    stage: stage === "agent" ? "agent" : "cleanup",
  };
  const trimmedProvider = typeof provider === "string" ? provider.trim() : "";
  if (trimmedProvider) {
    warning.provider = trimmedProvider;
  }
  return warning;
}

export function normalizeTranscriptionWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];

  const seen = new Set();
  const normalized = [];

  for (const warning of warnings) {
    if (!warning || typeof warning !== "object") continue;
    if (warning.type !== CLEANUP_FAILED_WARNING) continue;

    const stage = warning.stage === "agent" ? "agent" : "cleanup";
    const provider = typeof warning.provider === "string" ? warning.provider.trim() : "";
    const key = `${warning.type}:${stage}:${provider}`;
    if (seen.has(key)) continue;

    seen.add(key);
    normalized.push(
      provider ? { type: warning.type, stage, provider } : { type: warning.type, stage }
    );
  }

  return normalized;
}

export function mergeTranscriptionWarnings(...warningLists) {
  return normalizeTranscriptionWarnings(warningLists.flat());
}

export function withTranscriptionWarnings(result, ...warningLists) {
  const warnings = mergeTranscriptionWarnings(result?.warnings, ...warningLists);
  return warnings.length ? { ...result, warnings } : result;
}

export function createReasoningFallbackWarning(route, provider) {
  return createCleanupFailedWarning({
    stage: route?.kind === "agent" ? "agent" : "cleanup",
    provider: route?.config?.provider || provider,
  });
}

export function mergeReasoningFallbackWarning(warnings, route, provider) {
  return mergeTranscriptionWarnings(warnings, createReasoningFallbackWarning(route, provider));
}

export function normalizeProcessedTranscriptionResult(result, fallbackText = "") {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      text: typeof result.text === "string" ? result.text : fallbackText,
      warnings: normalizeTranscriptionWarnings(result.warnings),
    };
  }

  return {
    text: typeof result === "string" ? result : fallbackText,
    warnings: [],
  };
}

export function hasCleanupFailedWarning(result) {
  return normalizeTranscriptionWarnings(result?.warnings).length > 0;
}

export function getCleanupFailedWarningToast(result, t, { transcriptionSaved = true } = {}) {
  if (transcriptionSaved === false) return null;
  if (!hasCleanupFailedWarning(result)) return null;
  return {
    title: t("hooks.audioRecording.cleanupWarning.title"),
    description: t("hooks.audioRecording.cleanupWarning.description"),
    variant: "default",
  };
}
