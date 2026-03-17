import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { Copy, Trash2, FileText, FolderOpen, RotateCcw, Loader2, AlertCircle } from "lucide-react";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";
import { cn } from "../lib/utils";
import { getCachedPlatform } from "../../utils/platform";

const platform = getCachedPlatform();

function getShowInFolderKey(): string {
  if (platform === "win32") return "controlPanel.history.showInFolderWindows";
  if (platform === "linux") return "controlPanel.history.showInFolderLinux";
  return "controlPanel.history.showInFolder";
}

interface TranscriptionItemProps {
  item: TranscriptionItemType;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onShowAudioInFolder?: (id: number) => void;
  onRetryTranscription?: (id: number) => Promise<void>;
  onOpenSettings?: () => void;
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
  const [isHovered, setIsHovered] = useState(false);
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
      await onRetryTranscription(item.id);
    } finally {
      setIsRetrying(false);
    }
  };

  const isFailed = item.status === "failed";
  const hasRawText = item.raw_text !== null;
  const hasAudio = item.has_audio === 1;
  const showUtilityGroup = hasRawText || hasAudio;

  return (
    <div
      className={cn(
        "group rounded-md border px-3 py-2.5 transition-colors duration-150",
        isFailed
          ? "border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
          : "border-border/40 dark:border-border-subtle/60 bg-card/50 dark:bg-surface-2/60 hover:bg-muted/30 dark:hover:bg-surface-2/80"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-start gap-3">
        {formattedTime && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-0.5">
            {formattedTime}
          </span>
        )}

        {isFailed ? (
          <div className="flex-1 min-w-0 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 text-destructive mt-0.5" />
            <div className="min-w-0">
              <p className="text-sm text-destructive font-medium">
                {t("controlPanel.history.transcriptionFailed")}
              </p>
              {item.error_message && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {item.error_message}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {hasAudio ? (
                  <>
                    <button
                      onClick={() => onOpenSettings?.()}
                      className="text-primary hover:underline cursor-pointer"
                    >
                      {t("controlPanel.history.failedCtaSettings")}
                    </button>{" "}
                    {t("controlPanel.history.failedCtaAndRetry")}
                  </>
                ) : (
                  <button
                    onClick={() => onOpenSettings?.()}
                    className="text-primary hover:underline cursor-pointer"
                  >
                    {t("controlPanel.history.failedCtaSettingsOnly")}
                  </button>
                )}
              </p>
            </div>
          </div>
        ) : (
          <p className="flex-1 min-w-0 text-foreground text-sm leading-[1.5] break-words">
            {item.text}
          </p>
        )}

        <div
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
            isFailed ? "opacity-100" : isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          {isFailed && hasAudio && (
            <Tooltip content={t("controlPanel.history.retryTranscription")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleRetry}
                disabled={isRetrying}
                className="h-6 w-6 rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {isRetrying ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
              </Button>
            </Tooltip>
          )}
          {!isFailed && hasRawText && (
            <Tooltip content={t("controlPanel.history.viewRawTranscript")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setIsExpanded(!isExpanded)}
                className={cn(
                  "h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10",
                  isExpanded && "text-primary"
                )}
              >
                <FileText size={12} />
              </Button>
            </Tooltip>
          )}
          {hasAudio && (
            <Tooltip content={t(getShowInFolderKey())}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onShowAudioInFolder?.(item.id)}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                <FolderOpen size={12} />
              </Button>
            </Tooltip>
          )}
          {!isFailed && hasAudio && (
            <Tooltip content={t("controlPanel.history.retryTranscription")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={handleRetry}
                disabled={isRetrying}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-primary hover:bg-primary/10"
              >
                {isRetrying ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
              </Button>
            </Tooltip>
          )}
          {showUtilityGroup && <div className="w-px h-3 bg-border/30" />}
          {!isFailed && (
            <Tooltip content={t("controlPanel.history.copyText")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onCopy(item.text)}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
              >
                <Copy size={12} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={t("controlPanel.history.deleteItem")}>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onDelete(item.id)}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 size={12} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {!isFailed && (
        <div
          className={cn(
            "overflow-hidden transition-all duration-200",
            isExpanded ? "max-h-96" : "max-h-0"
          )}
        >
          <div className="border-t border-border/20 mt-2 pt-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {t("controlPanel.history.rawTranscript")}
            </span>
            <p className="text-xs text-muted-foreground/80 leading-relaxed mt-1">{item.raw_text}</p>
            {item.raw_text === item.text && (
              <p className="text-[10px] text-muted-foreground/50 italic mt-1">
                {t("controlPanel.history.noAiProcessing")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
