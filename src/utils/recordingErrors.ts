import { TFunction } from "i18next";

export function getRecordingErrorTitle(
  error: { code?: string; title: string },
  t: TFunction
): string {
  return error.code === "AUTH_EXPIRED"
    ? t("hooks.audioRecording.errorTitles.sessionExpired")
    : error.code === "OFFLINE"
      ? t("hooks.audioRecording.errorTitles.offline")
      : error.code === "LIMIT_REACHED"
        ? t("hooks.audioRecording.errorTitles.dailyLimitReached")
        : error.title;
}
