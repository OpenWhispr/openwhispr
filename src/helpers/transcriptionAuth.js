export function shouldSkipTranscriptionApiKey(settings) {
  const transcriptionMode = (settings.transcriptionMode || "").trim();
  const remoteUrl = (settings.remoteTranscriptionUrl || "").trim();
  return transcriptionMode === "self-hosted" && remoteUrl.length > 0;
}
