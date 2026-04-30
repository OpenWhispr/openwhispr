import { TFunction } from "i18next";

type RecordingError = { code?: string; title: string; description?: string };

export function getRecordingErrorTitle(error: RecordingError, t: TFunction): string {
  if (error.code === "NETWORK_ERROR") return t(error.title);
  return error.code === "AUTH_EXPIRED"
    ? t("hooks.audioRecording.errorTitles.sessionExpired")
    : error.code === "OFFLINE"
      ? t("hooks.audioRecording.errorTitles.offline")
      : error.code === "LIMIT_REACHED"
        ? t("hooks.audioRecording.errorTitles.dailyLimitReached")
        : error.title;
}

export function getRecordingErrorDescription(error: RecordingError, t: TFunction): string {
  if (error.code === "NETWORK_ERROR" && error.description) return t(error.description);
  return error.description ?? "";
}
