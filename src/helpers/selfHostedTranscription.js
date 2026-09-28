export function isSelfHostedTranscription(settings) {
  const mode =
    typeof settings?.transcriptionMode === "string" ? settings.transcriptionMode.trim() : "";
  const remoteUrl =
    typeof settings?.remoteTranscriptionUrl === "string"
      ? settings.remoteTranscriptionUrl.trim()
      : "";
  return mode === "self-hosted" && remoteUrl.length > 0;
}

export function resolveSelfHostedTranscriptionModel(settings) {
  if (!isSelfHostedTranscription(settings)) return null;
  const model =
    typeof settings?.remoteTranscriptionModel === "string"
      ? settings.remoteTranscriptionModel.trim()
      : "";
  return model.length > 0 ? model : null;
}

// The explicit model id opts compatible custom endpoints into Orukeet's PCM
// protocol. Other self-hosted models retain their existing HTTP route.
export function isOrukeetEndpoint(settings) {
  return (
    settings?.cloudTranscriptionProvider === "custom" &&
    (settings?.remoteTranscriptionModel || settings?.cloudTranscriptionModel) ===
      "orukeet-v0.1.0" &&
    Boolean(settings?.remoteTranscriptionUrl || settings?.cloudTranscriptionBaseUrl)
  );
}

export function isOrukeetStreaming(settings) {
  return settings?.cloudTranscriptionMode === "byok" && isOrukeetEndpoint(settings);
}
