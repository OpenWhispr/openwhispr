import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Loader2, Sparkles, Cloud, X } from "lucide-react";
import TranscriptionItem from "./ui/TranscriptionItem";
import type { TranscriptionItem as TranscriptionItemType } from "../types/electron";
import { formatHotkeyLabel } from "../utils/hotkeys";
import { formatDateGroup } from "../utils/dateFormatting";

interface HistoryViewProps {
  history: TranscriptionItemType[];
  isLoading: boolean;
  hotkey: string;
  showCloudMigrationBanner: boolean;
  setShowCloudMigrationBanner: (show: boolean) => void;
  aiCTADismissed: boolean;
  setAiCTADismissed: (dismissed: boolean) => void;
  useReasoningModel: boolean;
  copyToClipboard: (text: string) => void;
  deleteTranscription: (id: number) => void;
  onOpenSettings: (section?: string) => void;
}

export default function HistoryView({
  history,
  isLoading,
  hotkey,
  showCloudMigrationBanner,
  setShowCloudMigrationBanner,
  aiCTADismissed,
  setAiCTADismissed,
  useReasoningModel,
  copyToClipboard,
  deleteTranscription,
  onOpenSettings,
}: HistoryViewProps) {
  const { t } = useTranslation();

  const groupedHistory = useMemo(() => {
    if (history.length === 0) return [];

    const groups: { label: string; items: TranscriptionItemType[] }[] = [];
    let currentLabel: string | null = null;

    for (const item of history) {
      const label = formatDateGroup(item.timestamp, t);

      if (label !== currentLabel) {
        groups.push({ label, items: [item] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }

    return groups;
  }, [history, t]);

  return (
    <div className="px-4 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        {showCloudMigrationBanner && (
          <div className="mb-3 relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
            <button
              onClick={() => {
                setShowCloudMigrationBanner(false);
                localStorage.setItem("cloudMigrationShown", "true");
              }}
              aria-label={t("common.close")}
              className="absolute top-2 right-2 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X size={14} />
            </button>
            <div className="flex items-start gap-3 pr-6">
              <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                <Cloud size={16} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground mb-0.5">
                  {t("controlPanel.cloudMigration.title")}
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  {t("controlPanel.cloudMigration.description")}
                </p>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setShowCloudMigrationBanner(false);
                    localStorage.setItem("cloudMigrationShown", "true");
                    onOpenSettings("transcription");
                  }}
                >
                  {t("controlPanel.cloudMigration.viewSettings")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {!useReasoningModel && !aiCTADismissed && (
          <div className="mb-3 relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
            <button
              onClick={() => {
                localStorage.setItem("aiCTADismissed", "true");
                setAiCTADismissed(true);
              }}
              aria-label={t("common.close")}
              className="absolute top-2 right-2 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X size={14} />
            </button>
            <div className="flex items-start gap-3 pr-6">
              <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
                <Sparkles size={16} className="text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground mb-0.5">
                  {t("controlPanel.aiCta.title")}
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  {t("controlPanel.aiCta.description")}
                </p>
                <Button
                  variant="default"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onOpenSettings("intelligence")}
                >
                  {t("controlPanel.aiCta.enable")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 size={14} className="animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
            </div>
          </div>
        ) : history.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <svg
                className="text-foreground dark:text-white mb-5"
                width="64"
                height="64"
                viewBox="0 0 64 64"
                fill="none"
              >
                <rect
                  x="24"
                  y="6"
                  width="16"
                  height="28"
                  rx="8"
                  fill="currentColor"
                  fillOpacity={0.04}
                  stroke="currentColor"
                  strokeOpacity={0.1}
                />
                <rect
                  x="28"
                  y="12"
                  width="8"
                  height="3"
                  rx="1.5"
                  fill="currentColor"
                  fillOpacity={0.06}
                />
                <path
                  d="M18 28c0 7.7 6.3 14 14 14s14-6.3 14-14"
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.07}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <line
                  x1="32"
                  y1="42"
                  x2="32"
                  y2="50"
                  stroke="currentColor"
                  strokeOpacity={0.07}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <line
                  x1="26"
                  y1="50"
                  x2="38"
                  y2="50"
                  stroke="currentColor"
                  strokeOpacity={0.07}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <path
                  d="M12 20a2 2 0 0 1 0 8"
                  stroke="currentColor"
                  strokeOpacity={0.04}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <path
                  d="M8 18a2 2 0 0 1 0 12"
                  stroke="currentColor"
                  strokeOpacity={0.03}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <path
                  d="M52 20a2 2 0 0 0 0 8"
                  stroke="currentColor"
                  strokeOpacity={0.04}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
                <path
                  d="M56 18a2 2 0 0 0 0 12"
                  stroke="currentColor"
                  strokeOpacity={0.03}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              </svg>
              <h3 className="text-xs font-semibold text-foreground/70 dark:text-foreground/60 mb-2">
                {t("controlPanel.history.empty")}
              </h3>
              <div className="flex items-center gap-2 text-xs text-foreground/50 dark:text-foreground/25">
                <span>{t("controlPanel.history.press")}</span>
                <kbd className="inline-flex items-center h-5 px-1.5 rounded-sm bg-surface-1 dark:bg-white/6 border border-border/50 text-xs font-mono font-medium text-foreground/60 dark:text-foreground/40">
                  {formatHotkeyLabel(hotkey)}
                </kbd>
                <span>{t("controlPanel.history.toStart")}</span>
              </div>
            </div>
          </div>
        ) : (
          <div>
            {groupedHistory.map((group, index) => (
              <div key={group.label}>
                <div
                  className={`sticky top-0 z-10 bg-background px-1 pb-2 ${index === 0 ? "pt-1" : "pt-5"}`}
                >
                  <span className="text-[11px] font-semibold text-muted-foreground dark:text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {group.items.map((item) => (
                    <TranscriptionItem
                      key={item.id}
                      item={item}
                      onCopy={copyToClipboard}
                      onDelete={deleteTranscription}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
