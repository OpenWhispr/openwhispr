export const DEFAULT_ORUKEET_MODEL = "orukeet-v0.1.0-q8";
// Run before migrations. Any saved transcription choice prevents initialization.
export function initializeOrukeetDefaults(storage: Pick<Storage, "getItem" | "setItem">) {
  const existing = [
    "useLocalWhisper",
    "localTranscriptionProvider",
    "parakeetModel",
    "whisperModel",
    "transcriptionMode",
    "cloudTranscriptionMode",
    "cloudTranscriptionProvider",
    "_providerSettingsMigrated",
    "meetingTranscriptionMode",
    "uploadTranscriptionMode",
  ];
  if (existing.some((key) => storage.getItem(key) !== null)) return false;
  for (const prefix of ["", "meeting", "upload"]) {
    const key = (name: string) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
    storage.setItem(key("useLocalWhisper"), "true");
    storage.setItem(key("localTranscriptionProvider"), "nvidia");
    storage.setItem(key("parakeetModel"), DEFAULT_ORUKEET_MODEL);
    storage.setItem(key("transcriptionMode"), "local");
  }
  return true;
}
