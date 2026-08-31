import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Cloud, Flame, Gauge, Loader2, Mic2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useSettings } from "../hooks/useSettings";
import { getAccountAnalyticsSummary, syncPendingAnalytics } from "../services/AnalyticsService";
import { localDateKey } from "../helpers/analytics";
import type { AnalyticsDailyBucket, AnalyticsSummary } from "../types/electron";
import { cn } from "./lib/utils";

const EMPTY_SUMMARY: AnalyticsSummary = {
  scope: "device",
  timeZone: "UTC",
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
  const { insightsSyncEnabled } = useSettings();
  const { enableInsightsSync, optInDialog } = useInsightsSyncOptIn();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState(false);
  // Every dictation broadcasts analytics-changed, so loads overlap; only the
  // newest one may write state, or a slow reply overwrites a fresher summary.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setSyncError(false);
    let local: AnalyticsSummary | null = null;
    try {
      local = await window.electronAPI.getAnalyticsSummary();
      if (isLoaded && isSignedIn && insightsSyncEnabled) {
        await syncPendingAnalytics();
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const account = await getAccountAnalyticsSummary(timeZone);
        if (requestId !== requestIdRef.current) return;
        setSummary(account);
      } else {
        if (requestId !== requestIdRef.current) return;
        setSummary(local);
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setSummary((current) => local || current || EMPTY_SUMMARY);
      setSyncError(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [insightsSyncEnabled, isLoaded, isSignedIn]);

  useEffect(() => {
    void load();
    return window.electronAPI.onAnalyticsChanged?.(() => void load());
  }, [load]);

  const number = useMemo(
    () => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }),
    []
  );

  if (loading && !summary) {
    return (
      <div className="flex min-h-64 items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const data = summary;
  if (!data) return null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t("insights.title")}</h1>
          <p className="mt-1 text-xs text-muted-foreground">{t("insights.description")}</p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Cloud size={13} />
          {isSignedIn && insightsSyncEnabled
            ? syncError
              ? t("insights.syncFallback")
              : t("insights.synced")
            : t("insights.onDevice")}
        </div>
      </div>

      {isSignedIn && !insightsSyncEnabled && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-primary/15 bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("insights.syncPrompt")}</p>
          <button
            type="button"
            onClick={enableInsightsSync}
            className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t("insights.enableSync")}
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          icon={Mic2}
          label={t("insights.wordsSpoken")}
          value={number.format(data.totalWords)}
          detail={t("insights.allTime")}
        />
        <MetricCard
          icon={Flame}
          label={t("insights.currentStreak")}
          value={t("insights.days", { count: data.currentStreakDays })}
          detail={t("insights.longestStreak", { count: data.longestStreakDays })}
        />
        <MetricCard
          icon={Gauge}
          label={t("insights.wordsPerMinute")}
          value={data.averageWpm == null ? "—" : number.format(data.averageWpm)}
          detail={t("insights.wpmCoverage", { count: data.wpmCoveragePercent })}
        />
        <MetricCard
          icon={BarChart3}
          label={t("insights.dictations")}
          value={number.format(data.totalDictations)}
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
        <Heatmap daily={data.daily} />
      </div>

      {optInDialog}
    </div>
  );
}
