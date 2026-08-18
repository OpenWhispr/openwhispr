import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Loader2, Sparkles, Cloud, X, Mic, Trash2, Archive } from "lucide-react";
import TranscriptionItem from "./ui/TranscriptionItem";
import { EmptyState } from "./ui/EmptyState";
import type { TranscriptionItem as TranscriptionItemType } from "../types/electron";
import { formatHotkeyLabel, parseHotkeyList } from "../utils/hotkeys";
import { formatDateGroup } from "../utils/dateFormatting";
import { cn } from "./lib/utils";
import { useUpcomingEvents } from "../hooks/useUpcomingEvents";
import UpcomingMeetings from "./UpcomingMeetings";
import { useSettingsStore } from "../stores/settingsStore";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";

interface HistoryViewProps {
  history: TranscriptionItemType[];
  isLoading: boolean;
  hotkey: string;
  showCloudMigrationBanner: boolean;
  setShowCloudMigrationBanner: (show: boolean) => void;
  aiCTADismissed: boolean;
  setAiCTADismissed: (dismissed: boolean) => void;
  useCleanupModel: boolean;
  copyToClipboard: (text: string) => void;
  deleteTranscription: (id: number) => void;
  clearAllTranscriptions: () => void;
  onOpenSettings: (section?: string) => void;
  onShowAudioInFolder: (id: number) => void;
  onRetryTranscription: (id: number, options?: { isRecover?: boolean }) => Promise<void>;
  showDiscarded: boolean;
  onToggleDiscarded: () => void;
}

export default function HistoryView({
  history,
  isLoading,
  hotkey,
  showCloudMigrationBanner,
  setShowCloudMigrationBanner,
  aiCTADismissed,
  setAiCTADismissed,
  useCleanupModel,
  copyToClipboard,
  deleteTranscription,
  clearAllTranscriptions,
  onOpenSettings,
  onShowAudioInFolder,
  onRetryTranscription,
  showDiscarded,
  onToggleDiscarded,
}: HistoryViewProps) {
  const { t } = useTranslation();
  const personalDataRetentionEnabled = useSettingsStore((s) => s.dataRetentionEnabled);
  const dataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, personalDataRetentionEnabled)
  );
  const { events, isLoading: eventsLoading, isConnected } = useUpcomingEvents();

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

  const discardedToggle = (
    <button
      onClick={onToggleDiscarded}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground/60 hover:!text-foreground hover:!bg-black/5 dark:hover:!bg-white/5 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 transition-all duration-200"
    >
      <Archive size={11} />
      <span>
        {showDiscarded
          ? t("controlPanel.history.discarded.hide")
          : t("controlPanel.history.discarded.show")}
      </span>
    </button>
  );

  return (
    <div className="px-4 pt-4 pb-6">
      <div className={cn("mx-auto", isConnected ? "max-w-5xl" : "max-w-3xl")}>
        {history.length === 0 && <div className="mb-2 flex justify-end">{discardedToggle}</div>}
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

        {!useCleanupModel && !aiCTADismissed && (
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

        <div className={cn(isConnected ? "flex gap-6" : "")}>
          <div className={cn("min-w-0", isConnected ? "flex-1" : "w-full")}>
            {isConnected && (
              <div className="flex items-center gap-1.5 pb-2.5">
                <Mic size={12} className="text-muted-foreground" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {t("upcoming.transcriptions")}
                </span>
              </div>
            )}
            {!dataRetentionEnabled && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 px-3.5 py-2.5 flex items-center gap-2.5">
                <span className="text-amber-600 dark:text-amber-400 shrink-0 text-sm">⊘</span>
                <p className="text-xs text-amber-700 dark:text-amber-300/90 leading-relaxed">
                  {t("controlPanel.history.dataRetentionDisabled")}
                </p>
              </div>
            )}
            {isLoading && history.length === 0 ? (
              <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
                <div className="flex items-center justify-center gap-2 py-8">
                  <Loader2 size={14} className="animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
                </div>
              </div>
            ) : history.length === 0 ? (
              <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
                <EmptyState
                  icon={Mic}
                  title={t("controlPanel.history.empty")}
                  description={
                    <span className="flex flex-wrap items-center justify-center gap-2">
                      <span>{t("controlPanel.history.press")}</span>
                      {parseHotkeyList(hotkey).map((hk, index) => (
                        <Fragment key={hk}>
                          {index > 0 && <span className="text-foreground/30">/</span>}
                          <kbd className="inline-flex items-center h-5 px-1.5 rounded-sm bg-surface-1 dark:bg-white/6 border border-border/50 text-xs font-mono font-medium text-foreground/60 dark:text-foreground/40">
                            {formatHotkeyLabel(hk)}
                          </kbd>
                        </Fragment>
                      ))}
                      <span>{t("controlPanel.history.toStart")}</span>
                    </span>
                  }
                  className="py-16"
                />
              </div>
            ) : (
              <div className="group">
                {groupedHistory.map((group, index) => (
                  <div key={group.label} className={index > 0 ? "mt-4" : ""}>
                    <div className="sticky -top-1 z-10 -mx-4 px-5 pt-2 pb-2 bg-background flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-muted-foreground dark:text-muted-foreground uppercase tracking-wide">
                        {group.label}
                      </span>
                      {index === 0 && (
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
                          {discardedToggle}
                          <button
                            onClick={clearAllTranscriptions}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground/60 hover:!text-destructive hover:!bg-destructive/8 dark:hover:!bg-destructive/10 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 transition-all duration-200"
                          >
                            <Trash2 size={11} />
                            <span>{t("controlPanel.history.clearAll")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="space-y-1.5 relative z-0">
                      {group.items.map((item) => (
                        <TranscriptionItem
                          key={item.id}
                          item={item}
                          onCopy={copyToClipboard}
                          onDelete={deleteTranscription}
                          onShowAudioInFolder={onShowAudioInFolder}
                          onRetryTranscription={onRetryTranscription}
                          onOpenSettings={() => onOpenSettings("transcription")}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isConnected && (
            <div className="w-64 shrink-0 hidden sm:block">
              <div className="sticky top-4">
                <UpcomingMeetings events={events} isLoading={eventsLoading} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
