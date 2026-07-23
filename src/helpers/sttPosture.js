/**
 * STT readiness posture for startup UX (#1079 / #1082).
 *
 * - local-ready: at least one Whisper/Parakeet model is on disk
 * - cloud-only: no local models, but a cloud/self-hosted provider is active
 * - unconfigured: no local models and no usable cloud/self-hosted provider
 */

export function hasDownloadedLocalModels(whisperModels = [], parakeetModels = []) {
  const anyDownloaded = (models) =>
    Array.isArray(models) && models.some((m) => m && (m.downloaded === true || m.isDownloaded === true));
  return anyDownloaded(whisperModels) || anyDownloaded(parakeetModels);
}

export function hasTranscriptionProviderKey(settings = {}) {
  const provider = settings.cloudTranscriptionProvider || "openai";
  const trim = (v) => (typeof v === "string" ? v.trim() : "");

  switch (provider) {
    case "groq":
      return !!trim(settings.groqApiKey);
    case "xai":
      return !!trim(settings.xaiApiKey);
    case "mistral":
      return !!trim(settings.mistralApiKey);
    case "tinfoil":
      return !!trim(settings.tinfoilApiKey);
    case "corti":
      return (
        (!!trim(settings.cortiClientId) && !!trim(settings.cortiClientSecret)) ||
        !!trim(settings.cortiApiKey)
      );
    case "custom":
      return !!trim(settings.customTranscriptionApiKey) || !!trim(settings.cloudTranscriptionBaseUrl);
    case "openai":
    default:
      return !!trim(settings.openaiApiKey);
  }
}

export function isCloudTranscriptionActive(settings = {}) {
  if (settings.useLocalWhisper) return false;

  const transcriptionMode =
    typeof settings.transcriptionMode === "string" ? settings.transcriptionMode.trim() : "";
  const cloudMode =
    typeof settings.cloudTranscriptionMode === "string"
      ? settings.cloudTranscriptionMode.trim()
      : "";
  const remoteUrl =
    typeof settings.remoteTranscriptionUrl === "string"
      ? settings.remoteTranscriptionUrl.trim()
      : "";

  if (transcriptionMode === "self-hosted" && remoteUrl.length > 0) return true;

  if (cloudMode === "openwhispr" || transcriptionMode === "openwhispr") {
    return !!settings.isSignedIn;
  }

  if (cloudMode === "byok" || transcriptionMode === "providers") {
    return hasTranscriptionProviderKey(settings);
  }

  return false;
}

export function resolveSttPosture({ hasLocalModels, cloudActive }) {
  if (hasLocalModels) return "local-ready";
  if (cloudActive) return "cloud-only";
  return "unconfigured";
}

/** i18n messageKey used when a cloud STT call fails with no local fallback (#1082). */
export function resolveCloudOnlyFailureMessageKey(posture) {
  return posture === "cloud-only" ? "hooks.audioRecording.cloudOnlyFailure.description" : null;
}
