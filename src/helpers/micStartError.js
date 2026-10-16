import { getCachedPlatform } from "../utils/platform";

// The recording error for a microphone that failed to open, or null when the
// failure wasn't the microphone's. `title` is the untranslated fallback; the
// pill translates the title by `code` and the description by `messageKey`.
export function describeMicStartError(error, platform = getCachedPlatform()) {
  switch (error?.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return {
        code: "MIC_PERMISSION_DENIED",
        title: "Microphone Access Denied",
        messageKey: "hooks.audioRecording.errorDescriptions.micPermissionDenied",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return {
        code: "MIC_NOT_FOUND",
        title: "No Microphone Found",
        messageKey: "hooks.audioRecording.errorDescriptions.micNotFound",
      };
    case "NotReadableError":
    case "TrackStartError":
      // On Windows this is also another app holding the mic in exclusive mode (#1138).
      return {
        code: "MIC_IN_USE",
        title: "Microphone In Use",
        messageKey:
          platform === "win32"
            ? "hooks.audioRecording.errorDescriptions.micInUseWindows"
            : "hooks.audioRecording.errorDescriptions.micInUse",
      };
    case "MicUnusableError":
      return {
        code: "MIC_MUTED",
        title: "Microphone Muted",
        messageKey: "hooks.audioRecording.errorDescriptions.micMuted",
      };
    default:
      return null;
  }
}
