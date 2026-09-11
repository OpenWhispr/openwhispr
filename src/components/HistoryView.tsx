import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import { useUiLocale } from "../hooks/useUiLocale";
import { Button } from "./ui/button";
import { Loader2, Sparkles, X, Mic, Trash2, Archive } from "./icons";
import TranscriptionItem from "./ui/TranscriptionItem";
import EmptyStateCard from "./ui/EmptyStateCard";
import type { TranscriptionItem as TranscriptionItemType } from "../types/electron";
import { formatHotkeyLabel, parseHotkeyList } from "../utils/hotkeys";
import { formatDateGroup } from "../utils/dateFormatting";
import { useUpcomingEvents } from "../hooks/useUpcomingEvents";
import UpcomingMeetings from "./UpcomingMeetings";
import { useSettingsStore } from "../stores/settingsStore";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";

const EMPTY_PREVIEW_WIDTHS = ["w-full", "w-4/5", "w-3/5"];

interface HistoryViewProps {
  history: TranscriptionItemType[];
  isLoading: boolean;
  hotkey: string;
  aiCTADismissed: boolean;
  setAiCTADismissed: (dismissed: boolean) => void;
  useCleanupModel: boolean;
  copyToClipboard: (text: string) => void;
  deleteTranscription: (id: number) => void;
  clearAllTranscriptions: () => void;
  onOpenSettings: (section?: string) => void;
  onOpenIntegrations: () => void;
  onShowAudioInFolder: (id: number) => void;
  onRetryTranscription: (id: number, options?: { isRecover?: boolean }) => Promise<void>;
  showDiscarded: boolean;
  onToggleDiscarded: () => void;
}

export default function HistoryView({
  history,
  isLoading,
  hotkey,
  aiCTADismissed,
  setAiCTADismissed,
  useCleanupModel,
  copyToClipboard,
  deleteTranscription,
  clearAllTranscriptions,
  onOpenSettings,
  onOpenIntegrations,
  onShowAudioInFolder,
  onRetryTranscription,
  showDiscarded,
  onToggleDiscarded,
}: HistoryViewProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
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
      const label = formatDateGroup(item.timestamp, t, locale);

      if (label !== currentLabel) {
        groups.push({ label, items: [item] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }

    return groups;
  }, [history, t, locale]);

  const discardedToggle = (
    <button
      onClick={onToggleDiscarded}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground/70 hover:!text-foreground hover:!bg-black/5 dark:hover:!bg-white/5 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 transition-all duration-200"
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
      <div className="mx-auto max-w-5xl">
        {!useCleanupModel && !aiCTADismissed && (
          <div className="mb-3 relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
            <button
              onClick={() => {
                localStorage.setItem("aiCTADismissed", "true");
                setAiCTADismissed(true);
              }}
              aria-label={t("common.close")}
              className="absolute top-2 end-2 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X size={14} />
            </button>
            <div className="flex items-start gap-3 pe-6">
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

        <div className="flex gap-8">
          <div className="min-w-0 flex-1">
            {!dataRetentionEnabled && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 px-3.5 py-2.5 flex items-center gap-2.5">
                <span className="text-amber-600 dark:text-amber-400 shrink-0 text-sm">⊘</span>
                <p className="text-xs text-amber-700 dark:text-amber-300/90 leading-relaxed">
                  {t("controlPanel.history.dataRetentionDisabled")}
                </p>
              </div>
            )}
            {isLoading && history.length === 0 ? (
              <div className="rounded-2xl border border-border/70 bg-card/50 dark:border-white/10 dark:bg-surface-2/60">
                <div className="flex items-center justify-center gap-2 py-10">
                  <Loader2 size={14} className="animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
                </div>
              </div>
            ) : history.length === 0 ? (
              <>
                <p className="pt-2 pb-2.5 text-sm text-muted-foreground">
                  {t("controlPanel.history.sectionTitle")}
                </p>
                <EmptyStateCard
                  icon={Mic}
                  title={t("controlPanel.history.empty")}
                  description={t("controlPanel.history.emptyDescription")}
                >
                  {/* Ghost rows preview the list this card becomes. */}
                  <div aria-hidden="true" className="mb-1 w-56 space-y-2">
                    {EMPTY_PREVIEW_WIDTHS.map((width) => (
                      <span
                        key={width}
                        className={cn(
                          "block h-2 rounded-full bg-foreground/6 dark:bg-white/8",
                          width
                        )}
                      />
                    ))}
                  </div>
                  <span className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-surface-3 px-3 text-xs font-medium text-foreground/70 dark:bg-surface-3">
                    {t("controlPanel.history.press")}
                    <span dir="ltr" className="inline-flex items-center gap-1">
                      {parseHotkeyList(hotkey).map((hk, index) => (
                        <Fragment key={hk}>
                          {index > 0 && <span className="text-foreground/45">/</span>}
                          <kbd className="rounded-md bg-background px-1.5 py-px font-sans text-[11px] font-medium text-foreground/80 shadow-sm dark:bg-surface-2">
                            {formatHotkeyLabel(hk)}
                          </kbd>
                        </Fragment>
                      ))}
                    </span>
                    {t("controlPanel.history.toStart")}
                  </span>
                </EmptyStateCard>
              </>
            ) : (
              <div className="group">
                {groupedHistory.map((group, index) => (
                  <div key={group.label} className={index > 0 ? "mt-6" : ""}>
                    <div className="sticky -top-1 z-10 -mx-4 px-4 pt-2 pb-2.5 bg-background flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">{group.label}</span>
                      {index === 0 && (
                        <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
                          {discardedToggle}
                          <button
                            onClick={clearAllTranscriptions}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground/70 hover:!text-destructive hover:!bg-destructive/8 dark:hover:!bg-destructive/10 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 transition-all duration-200"
                          >
                            <Trash2 size={11} />
                            <span>{t("controlPanel.history.clearAll")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="relative z-0 overflow-clip rounded-2xl border border-border/70 bg-card/50 divide-y divide-border/60 dark:border-white/10 dark:bg-surface-2/60">
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

          <div className="hidden w-80 shrink-0 md:block">
            <UpcomingMeetings
              events={events}
              isLoading={eventsLoading}
              isConnected={isConnected}
              onConnectCalendar={onOpenIntegrations}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
