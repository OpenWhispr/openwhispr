import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  Copy,
  Trash2,
  FileText,
  FolderOpen,
  RotateCcw,
  Loader2,
  AlertCircle,
  ArchiveRestore,
  MoreVertical,
} from "../icons";
import type {
  TranscriptionItem as TranscriptionItemType,
  TranscriptionErrorCode,
} from "../../types/electron";
import { cn } from "../lib/utils";
import { getCachedPlatform, showInFolderLabelKey } from "../../utils/platform";
import { formatMmSs } from "../../utils/formatDuration";

const platform = getCachedPlatform();

const ACTION_BUTTON_CLASS =
  "h-7 w-7 rounded-full text-secondary/70 hover:text-primary hover:bg-text-primary/6 dark:hover:bg-white/6";

const TRANSCRIPT_TEXT_CLASS =
  "text-base leading-normal wrap-break-word whitespace-pre-wrap text-primary";

interface MenuAction {
  key: string;
  icon: typeof Copy;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

interface TranscriptionItemProps {
  item: TranscriptionItemType;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onShowAudioInFolder?: (id: number) => void;
  onRetryTranscription?: (id: number, options?: { isRecover?: boolean }) => Promise<void>;
  onOpenSettings?: (section?: string) => void;
}

export default function TranscriptionItem({
  item,
  onCopy,
  onDelete,
  onShowAudioInFolder,
  onRetryTranscription,
  onOpenSettings,
}: TranscriptionItemProps) {
  const { t, i18n } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTime = Number.isNaN(timestampDate.getTime())
    ? ""
    : timestampDate.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });

  const handleRetry = async () => {
    if (isRetrying || !onRetryTranscription) return;
    setIsRetrying(true);
    try {
      await onRetryTranscription(item.id, { isRecover: item.status === "discarded" });
    } finally {
      setIsRetrying(false);
    }
  };

  const isFailed = item.status === "failed";
  const isDiscarded = item.status === "discarded";
  const isTranscribed = !isFailed && !isDiscarded;
  const discardedDuration =
    item.audio_duration_ms && item.audio_duration_ms > 0
      ? formatMmSs(Math.round(item.audio_duration_ms / 1000))
      : null;
  const rawText = item.raw_text;
  const hasAudio = item.has_audio === 1;
  // A failed row keeps the transcript when only a later step failed.
  const hasKeptText = isFailed && item.text.trim() !== "";

  const errorCode = item.error_code as TranscriptionErrorCode;
  const isConfigError =
    errorCode === "API_KEY_MISSING" ||
    errorCode === "INVALID_KEY" ||
    errorCode === "PROVIDER_AUTH_FAILED" ||
    errorCode === "PROVIDER_ACCESS_DENIED" ||
    errorCode === "PROVIDER_QUOTA_EXHAUSTED" ||
    errorCode === "PROVIDER_MODEL_NOT_FOUND" ||
    errorCode === "PROVIDER_NO_RESPONSE" ||
    errorCode === "MODEL_NOT_AVAILABLE" ||
    errorCode === "CUSTOM_ENDPOINT_INVALID";
  const isLimitError = errorCode === "LIMIT_REACHED";
  const isOfflineError = errorCode === "OFFLINE";
  // The saved message is English; show the translated one.
  const errorText =
    errorCode === "OPENROUTER_OUT_OF_CREDITS"
      ? t("hooks.audioRecording.errorDescriptions.openRouterOutOfCredits")
      : item.error_message;

  const retryLabel = t(
    item.route_kind === "translation"
      ? "controlPanel.history.retryTranslationMode"
      : "controlPanel.history.retryTranscription"
  );

  // Copy stays visible as the one-tap action; everything else lives in the menu.
  const candidateActions: (MenuAction | false)[] = [
    isDiscarded &&
      hasAudio && {
        key: "recover",
        icon: ArchiveRestore,
        label: t("controlPanel.history.discarded.recover"),
        onSelect: handleRetry,
      },
    !isDiscarded &&
      hasAudio && { key: "retry", icon: RotateCcw, label: retryLabel, onSelect: handleRetry },
    isTranscribed &&
      rawText !== null && {
        key: "raw",
        icon: FileText,
        label: t("controlPanel.history.viewRawTranscript"),
        onSelect: () => setIsExpanded((expanded) => !expanded),
      },
    hasAudio && {
      key: "folder",
      icon: FolderOpen,
      label: t(showInFolderLabelKey(platform)),
      onSelect: () => onShowAudioInFolder?.(item.id),
    },
    {
      key: "delete",
      icon: Trash2,
      label: t("controlPanel.history.deleteItem"),
      onSelect: () => onDelete(item.id),
      destructive: true,
    },
  ];
  const menuActions = candidateActions.filter((action): action is MenuAction => action !== false);

  return (
    <div
      className={cn(
        "group/row px-4 py-3 transition-colors duration-150",
        isFailed
          ? "bg-red-solid/5"
          : isDiscarded
            ? "bg-surface-secondary/20 opacity-80"
            : "hover:bg-surface-secondary/20 dark:hover:bg-white/2",
        // Translation rows get a 2px primary accent; ps-[14px] keeps text aligned with the other rows.
        item.route_kind === "translation" && "border-s-2 border-s-brand-solid/70 ps-[14px]"
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs tabular-nums text-secondary">{formattedTime}</span>
        <div
          className={cn(
            "-me-1.5 flex items-center gap-1 transition-opacity duration-150",
            // Actions surface on hover, keyboard focus, or while the menu is open; failed and
            // discarded rows keep them visible because recovery is the point of the row.
            isTranscribed &&
              "opacity-0 group-hover/row:opacity-100 has-[:focus-visible]:opacity-100 has-[[data-state=open]]:opacity-100"
          )}
        >
          {(isTranscribed || hasKeptText) && (
            <Tooltip content={t("controlPanel.history.copyText")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onCopy(item.text)}
                aria-label={t("controlPanel.history.copyText")}
                className={ACTION_BUTTON_CLASS}
              >
                <Copy size={13} />
              </Button>
            </Tooltip>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                disabled={isRetrying}
                aria-label={t("controlPanel.history.moreActions")}
                className={ACTION_BUTTON_CLASS}
              >
                {isRetrying ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <MoreVertical size={13} />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menuActions.map(({ key, icon: Icon, label, onSelect, destructive }) => (
                <DropdownMenuItem
                  key={key}
                  onSelect={onSelect}
                  className={cn(
                    "gap-2.5",
                    destructive && "text-red-solid focus:bg-red-solid/8 focus:text-red-solid"
                  )}
                >
                  <Icon size={14} className="shrink-0 opacity-70" />
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-1.5">
        {isFailed ? (
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-solid" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-red-solid">
                {t(
                  hasKeptText
                    ? "controlPanel.history.editFailedTranscriptKept"
                    : "controlPanel.history.transcriptionFailed"
                )}
              </p>
              {errorText && (
                <p className="mt-0.5 text-xs leading-relaxed wrap-break-word text-secondary">
                  {errorText}
                </p>
              )}
              {isConfigError && hasKeptText && (
                <p className="mt-1 text-xs text-secondary">
                  <button
                    onClick={() => onOpenSettings?.("dictationAgent")}
                    className="cursor-pointer text-brand-solid hover:underline"
                  >
                    {t("controlPanel.history.failedCtaAiSettings")}
                  </button>
                </p>
              )}
              {isConfigError && !hasKeptText && (
                <p className="mt-1 text-xs text-secondary">
                  {hasAudio ? (
                    <>
                      <button
                        onClick={() => onOpenSettings?.()}
                        className="cursor-pointer text-brand-solid hover:underline"
                      >
                        {t("controlPanel.history.failedCtaSettings")}
                      </button>{" "}
                      {t("controlPanel.history.failedCtaAndRetry")}
                    </>
                  ) : (
                    <button
                      onClick={() => onOpenSettings?.()}
                      className="cursor-pointer text-brand-solid hover:underline"
                    >
                      {t("controlPanel.history.failedCtaSettingsOnly")}
                    </button>
                  )}
                </p>
              )}
              {isLimitError && (
                <p className="mt-1 text-xs text-secondary">
                  {t("controlPanel.history.failedLimitReached")}
                </p>
              )}
              {isOfflineError && (
                <p className="mt-1 text-xs text-secondary">
                  {t("controlPanel.history.failedOffline")}
                </p>
              )}
            </div>
          </div>
        ) : isDiscarded ? (
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded-sm bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary">
              {t("controlPanel.history.discarded.badge")}
            </span>
            <span className="truncate text-sm text-secondary">
              {discardedDuration
                ? t("controlPanel.history.discarded.recordingWithDuration", {
                    duration: discardedDuration,
                  })
                : t("controlPanel.history.discarded.recording")}
            </span>
          </div>
        ) : (
          <p dir="auto" className={TRANSCRIPT_TEXT_CLASS}>
            {item.text}
          </p>
        )}
        {hasKeptText && (
          <p dir="auto" className={cn("mt-2", TRANSCRIPT_TEXT_CLASS)}>
            {item.text}
          </p>
        )}
      </div>

      {isTranscribed && rawText !== null && (
        <div
          inert={!isExpanded}
          className={cn(
            "grid transition-[grid-template-rows] duration-200",
            isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="mt-2 border-t border-default/70 pt-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wider text-secondary">
                  {t("controlPanel.history.rawTranscript")}
                </span>
                <Tooltip content={t("controlPanel.history.copyRawTranscript")}>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onCopy(rawText)}
                    className="h-5 w-5 rounded-sm text-secondary hover:bg-text-primary/10 hover:text-primary"
                  >
                    <Copy size={10} />
                  </Button>
                </Tooltip>
              </div>
              <p dir="auto" className="mt-1 text-xs leading-relaxed text-secondary/80">
                {rawText}
              </p>
              {rawText === item.text && (
                <p className="mt-1 text-[10px] italic text-secondary/70">
                  {t("controlPanel.history.noAiProcessing")}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
