import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Cloud, Flame, Gauge, Loader2, Mic2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useSettings } from "../hooks/useSettings";
import { getAccountAnalyticsSummary, syncPendingAnalytics } from "../services/AnalyticsService";
import { localDateKey } from "../helpers/analytics";
import { canOfferAnalyticsClaim } from "../services/syncPassPolicy";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import type { AnalyticsDailyBucket, AnalyticsSummary } from "../types/electron";
import { cn } from "./lib/utils";

const EMPTY_SUMMARY: AnalyticsSummary = {
  totalWords: 0,
  totalDictations: 0,
  totalSpokenDurationMs: 0,
  averageWpm: null,
  currentStreakDays: 0,
  longestStreakDays: 0,
  wpmCoveragePercent: 0,
  daily: [],
};

function Heatmap({ daily }: { daily: AnalyticsDailyBucket[] }) {
  const { t } = useTranslation();
  const days = useMemo(() => {
    const byDate = new Map(daily.map((bucket) => [bucket.date, bucket]));
    const today = new Date();
    return Array.from({ length: 365 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364 + index);
      const key = localDateKey(date);
      return { date: key, words: byDate.get(key)?.words || 0 };
    });
  }, [daily]);
  const maxWords = Math.max(1, ...days.map((day) => day.words));

  return (
    <div className="overflow-x-auto pb-1">
      <div
        className="grid grid-flow-col grid-rows-7 gap-1 min-w-max"
        role="img"
        aria-label={t("insights.activityLabel")}
      >
        {days.map((day) => {
          const intensity =
            day.words === 0 ? 0 : Math.max(1, Math.ceil((day.words / maxWords) * 4));
          return (
            <div
              key={day.date}
              title={t("insights.dayTooltip", { date: day.date, count: day.words })}
              className={cn(
                "h-2.5 w-2.5 rounded-[2px]",
                intensity === 0 && "bg-foreground/6 dark:bg-white/6",
                intensity === 1 && "bg-primary/25",
                intensity === 2 && "bg-primary/45",
                intensity === 3 && "bg-primary/70",
                intensity === 4 && "bg-primary"
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-border/40 dark:border-white/8 bg-card/70 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon size={14} />
        <span className="text-xs">{label}</span>
      </div>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
      <p className="mt-1 text-[11px] text-muted-foreground/70">{detail}</p>
    </div>
  );
}

export default function InsightsView() {
  const { t } = useTranslation();
  const { isSignedIn, isLoaded } = useAuth();
  const { dataRetentionEnabled: personalDataRetentionEnabled, insightsSyncEnabled } = useSettings();
  const dataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, personalDataRetentionEnabled)
  );
  const { enableInsightsSync, optInDialog, syncAllowedByPolicy, unclaimedCount } =
    useInsightsSyncOptIn();
  // A managed workspace that forbids cloud backup forbids these counters with
  // it, so the view stays device-scoped even with the preference left on.
  const syncActive = isSignedIn && insightsSyncEnabled && syncAllowedByPolicy;
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState(false);
  // Every dictation broadcasts analytics-changed, so loads overlap; only the
  // newest one may write state, or a slow reply overwrites a fresher summary.
  // A superseded load also bails before syncing, so two passes cannot share a
  // batch and leave the winner reading a summary the other has not finished.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setSyncError(false);
    let local: AnalyticsSummary | null = null;
    try {
      local = await window.electronAPI.getAnalyticsSummary();
      if (requestId !== requestIdRef.current) return;
      if (isLoaded && syncActive) {
        await syncPendingAnalytics();
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const account = await getAccountAnalyticsSummary(timeZone);
        if (requestId !== requestIdRef.current) return;
        setSummary(account);
      } else {
        setSummary(local);
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setSummary((current) => local || current || EMPTY_SUMMARY);
      setSyncError(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [isLoaded, syncActive]);

  useEffect(() => {
    void load();
    return window.electronAPI.onAnalyticsChanged?.(() => void load());
  }, [load]);

  const number = useMemo(
    () => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }),
    []
  );

  if (!summary) {
    if (!loading) return null;
    return (
      <div className="flex min-h-64 items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("insights.title")}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t("insights.description")}</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Cloud size={13} />
          {syncActive
            ? syncError
              ? t("insights.syncFallback")
              : t("insights.synced")
            : t("insights.onDevice")}
        </div>
      </div>

      {!dataRetentionEnabled && (
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/5 dark:bg-amber-500/10 px-3.5 py-2.5 flex items-center gap-2.5">
          <span className="text-amber-600 dark:text-amber-400 shrink-0 text-sm">⊘</span>
          <p className="text-xs text-amber-700 dark:text-amber-300/90 leading-relaxed">
            {t("insights.dataRetentionDisabled")}
          </p>
        </div>
      )}

      {canOfferAnalyticsClaim({
        signedIn: isSignedIn,
        syncAllowedByPolicy,
        dataRetentionEnabled,
        insightsSyncEnabled,
        unclaimedCount,
      }) && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {t(insightsSyncEnabled ? "insights.claimTitle" : "insights.syncPrompt")}
          </p>
          <button
            type="button"
            onClick={enableInsightsSync}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t(insightsSyncEnabled ? "insights.claimInclude" : "insights.enableSync")}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          icon={Mic2}
          label={t("insights.wordsSpoken")}
          value={number.format(summary.totalWords)}
          detail={t("insights.allTime")}
        />
        <MetricCard
          icon={Flame}
          label={t("insights.currentStreak")}
          value={t("insights.days", { count: summary.currentStreakDays })}
          detail={t("insights.longestStreak", { count: summary.longestStreakDays })}
        />
        <MetricCard
          icon={Gauge}
          label={t("insights.wordsPerMinute")}
          value={summary.averageWpm == null ? "—" : number.format(summary.averageWpm)}
          detail={t("insights.wpmCoverage", { count: summary.wpmCoveragePercent })}
        />
        <MetricCard
          icon={BarChart3}
          label={t("insights.dictations")}
          value={number.format(summary.totalDictations)}
          detail={t("insights.allTime")}
        />
      </div>

      <div className="mt-5 rounded-xl border border-border/40 dark:border-white/8 bg-card/70 p-4">
        <div className="mb-4">
          <h2 className="text-sm font-medium text-foreground">{t("insights.activity")}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {t("insights.activityDescription")}
          </p>
        </div>
        <Heatmap daily={summary.daily} />
      </div>

      {optInDialog}
    </div>
  );
}
