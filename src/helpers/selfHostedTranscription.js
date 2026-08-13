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
