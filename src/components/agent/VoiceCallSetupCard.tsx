import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "../icons";
import { ICON_BUTTON, PILL_BUTTON, PRIMARY_PILL_BUTTON } from "../chat/interactions/cardStyles";
import { openProviderSettings } from "../../utils/describeProviderError";
import { useSettingsStore } from "../../stores/settingsStore";
import { isCancellation } from "../../hooks/useModelDownload";
import { LOCAL_MODEL_REFUSAL_MESSAGE_KEYS } from "../../stores/policyRules";
import type { VoiceCallStartFailure } from "./useVoiceCall";
import { useLanguageName } from "./VoiceCallSettings";

type Action = "download" | "settings" | "llmSettings" | "micSettings" | "language" | "retry";

const ACTIONS: Record<VoiceCallStartFailure["reason"], Action | null> = {
  "voice-models-missing": "download",
  "speech-model-missing": "settings",
  "speech-model-refused": "settings",
  "language-model-missing": "language",
  "language-unsupported": "language",
  "brain-not-downloaded": "llmSettings",
  "brain-sign-in-required": "llmSettings",
  "brain-key-missing": "llmSettings",
  "meeting-recording": null,
  "mic-busy": null,
  "mic-denied": "micSettings",
  "start-failed": "retry",
};

const ACTION_LABELS: Record<Action, string> = {
  download: "agentWindow.call.setup.download",
  settings: "agentWindow.call.setup.openSettings",
  llmSettings: "agentWindow.call.setup.openSettings",
  micSettings: "agentWindow.call.setup.openSettings",
  language: "agentWindow.call.setup.changeLanguage",
  retry: "agentWindow.call.setup.retry",
};

interface VoiceCallSetupCardProps {
  failure: VoiceCallStartFailure;
  /** Try the call again (after the voice models downloaded). */
  onRetry: () => void;
  onChangeLanguage: () => void;
  onClose: () => void;
}

/** Why a call couldn't start, with what fixes it: a download, Settings, or another language. */
export function VoiceCallSetupCard({
  failure,
  onRetry,
  onChangeLanguage,
  onClose,
}: VoiceCallSetupCardProps) {
  const { t } = useTranslation();
  const nameOf = useLanguageName();
  const language = useSettingsStore((state) => state.voiceCallLanguage);
  const [download, setDownload] = useState<{ percent: number } | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const action = ACTIONS[failure.reason];
  const missingBytes = "missingBytes" in failure ? (failure.missingBytes ?? 0) : 0;
  // Each model reports its own bytes; the card shows them all as one download.
  const bytesByModel = useRef(new Map<string, number>());
  const downloading = download !== null;

  useEffect(() => {
    if (!downloading) return undefined;
    bytesByModel.current.clear();
    return window.electronAPI?.voiceConversation?.onDownloadProgress(
      ({ model, downloadedBytes, totalBytes }) => {
        bytesByModel.current.set(model, downloadedBytes);
        const done = [...bytesByModel.current.values()].reduce((sum, bytes) => sum + bytes, 0);
        const total = missingBytes || totalBytes;
        if (total > 0) setDownload({ percent: Math.min(99, Math.round((done / total) * 100)) });
      }
    );
  }, [downloading, missingBytes]);

  const cancelDownload = () =>
    void window.electronAPI?.voiceConversation?.cancelModelDownload().catch(() => {});

  const startDownload = () => {
    setDownloadFailed(false);
    setDownload({ percent: 0 });
    void window.electronAPI?.voiceConversation
      ?.downloadModels()
      .then((status) => {
        setDownload(null);
        if (status.ready) onRetry();
        else setDownloadFailed(true);
      })
      .catch((error: Error) => {
        setDownload(null);
        setDownloadFailed(!isCancellation(error?.message));
      });
  };

  const run = (chosen: Action) => {
    if (chosen === "download") startDownload();
    else if (chosen === "settings") openProviderSettings("speechToText");
    else if (chosen === "llmSettings") openProviderSettings("llms");
    else if (chosen === "micSettings") void window.electronAPI?.openMicrophoneSettings?.();
    else if (chosen === "language") onChangeLanguage();
    else onRetry();
  };

  const missingMb = missingBytes ? Math.ceil(missingBytes / 1_000_000) : null;

  return (
    <div
      role="alertdialog"
      aria-labelledby="voice-call-setup-message"
      className="flex flex-col gap-3 rounded-2xl bg-surface-1 p-3 text-[15px] text-foreground"
    >
      <div className="flex items-start gap-2">
        <p id="voice-call-setup-message" dir="auto" className="flex-1 pt-1">
          {downloadFailed
            ? t("agentWindow.call.setup.downloadFailed")
            : failure.reason === "speech-model-refused"
              ? t(LOCAL_MODEL_REFUSAL_MESSAGE_KEYS[failure.code])
              : t(`agentWindow.call.setup.reasons.${failure.reason}`, {
                  size: missingMb ?? "",
                  language: nameOf(language),
                })}
        </p>
        <button
          type="button"
          // Closing stops the download; a card that only moves (a minimize) lets it go on.
          onClick={() => {
            cancelDownload();
            onClose();
          }}
          aria-label={t("agentWindow.actions.close")}
          title={t("agentWindow.actions.close")}
          className={ICON_BUTTON}
        >
          <X size={15} />
        </button>
      </div>
      {action && (
        <div className="flex items-center justify-end gap-2">
          {download ? (
            <>
              <span className="text-[13px] text-muted-foreground" aria-live="polite">
                {t("agentWindow.call.setup.downloading", { percent: download.percent })}
              </span>
              <button type="button" onClick={cancelDownload} className={PILL_BUTTON}>
                {t("agentWindow.call.setup.cancel")}
              </button>
            </>
          ) : (
            <>
              {/* A model that hears the language is a download in Settings. */}
              {failure.reason === "language-model-missing" && (
                <button type="button" onClick={() => run("settings")} className={PILL_BUTTON}>
                  {t(ACTION_LABELS.settings)}
                </button>
              )}
              <button type="button" onClick={() => run(action)} className={PRIMARY_PILL_BUTTON}>
                {t(ACTION_LABELS[action])}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
