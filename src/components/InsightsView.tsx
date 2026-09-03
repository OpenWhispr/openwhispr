import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Cloud, Flame, Gauge, Loader2, Mic2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import { useInsightsSyncOptIn } from "../hooks/useInsightsSyncOptIn";
import { useSettings } from "../hooks/useSettings";
import {
  getAccountAnalyticsSummary,
  subscribeToAnalyticsRefresh,
  syncPendingAnalytics,
} from "../services/AnalyticsService";
import { buildAnalyticsActivityDays } from "../helpers/analytics";
import { canOfferAnalyticsClaim } from "../services/syncPassPolicy";
import { effectiveLocalHistoryEnabled } from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import type { AnalyticsDailyBucket, AnalyticsSummary } from "../types/electron";
import { cn } from "./lib/utils";
import { Tooltip } from "./ui/tooltip";

type ActivityDay = { date: string; words: number };

const ACTIVITY_INTENSITY_CLASSES = [
  "bg-foreground/6 dark:bg-white/6",
  "bg-primary/25",
  "bg-primary/45",
  "bg-primary/70",
  "bg-primary",
] as const;

function dateFromLocalKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function Heatmap({ daily }: { daily: AnalyticsDailyBucket[] }) {
  const { t, i18n } = useTranslation();
  const calendar = useMemo(() => {
    const days: ActivityDay[] = buildAnalyticsActivityDays(daily);
    const cells: Array<ActivityDay | null> = [
      ...Array(dateFromLocalKey(days[0].date).getDay()).fill(null),
      ...days,
    ];
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks = Array.from({ length: cells.length / 7 }, (_, index) =>
      cells.slice(index * 7, index * 7 + 7)
    );
    const monthFormatter = new Intl.DateTimeFormat(i18n.language, { month: "short" });
    let previousMonth = "";
    const monthLabels = weeks.map((week, index) => {
      const labelDay =
        week.find((day) => day?.date.endsWith("-01")) ||
        (index === 0 ? week.find((day) => day !== null) : null);
      if (!labelDay) return null;
      const month = labelDay.date.slice(0, 7);
      if (month === previousMonth) return null;
      previousMonth = month;
      return monthFormatter.format(dateFromLocalKey(labelDay.date));
    });

    return {
      maxWords: Math.max(1, ...days.map((day) => day.words)),
      monthLabels,
      todayDate: days[days.length - 1].date,
      weeks,
    };
  }, [daily, i18n.language]);

  const weekdayLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) =>
        new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(
          new Date(2024, 0, 7 + index, 12)
        )
      ),
    [i18n.language]
  );
  // Fixed tracks, sized to the 1.5rem cells they hold. minmax(0, 1fr) let every
  // week column collapse toward zero while the cells stayed 24px wide, so the
  // squares overflowed their tracks and overlapped each other; the grid also
  // contributed no intrinsic width, leaving overflow-x nothing to scroll, so
  // the newest weeks — today's cell among them — were painted outside the
  // scrollable area on any window narrower than about 1050px.
  const columnStyle = { gridTemplateColumns: `repeat(${calendar.weeks.length}, 1.5rem)` };

  return (
    // Focusable, so the chart can be scrolled without a mouse. role="img" used
    // to sit on the container, which made every descendant presentational and
    // silently discarded the per-day labels below it; the cells carry it now
    // and the group only names the chart.
    <div
      className="overflow-x-auto rounded-sm pb-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      tabIndex={0}
      role="group"
      aria-label={t("insights.activityLabel")}
    >
      <div className="w-max">
        <div className="grid grid-cols-[auto_max-content] gap-x-3">
          <div aria-hidden="true" />
          <div className="grid h-4 gap-2" style={columnStyle} aria-hidden="true">
            {calendar.monthLabels.map((label, index) => (
              <span
                key={index}
                className="truncate text-[10px] font-medium text-muted-foreground/70"
              >
                {label}
              </span>
            ))}
          </div>

          <div className="grid grid-rows-7 gap-0.5" aria-hidden="true">
            {weekdayLabels.map((label) => (
              <span key={label} className="flex items-center text-[10px] text-muted-foreground/70">
                {label}
              </span>
            ))}
          </div>

          <div className="grid gap-2" style={columnStyle}>
            {calendar.weeks.map((week, weekIndex) => (
              <div key={weekIndex} className="grid grid-rows-7 gap-0.5">
                {week.map((day, dayIndex) => {
                  if (!day) {
                    return (
                      <div
                        key={dayIndex}
                        aria-hidden="true"
                        className="size-6 justify-self-center"
                      />
                    );
                  }
                  const intensity =
                    day.words === 0
                      ? 0
                      : Math.max(1, Math.ceil((day.words / calendar.maxWords) * 4));
                  const tooltip = t("insights.dayTooltip", {
                    date: day.date,
                    count: day.words,
                  });
                  return (
                    <div key={day.date} className="justify-self-center">
                      <Tooltip content={tooltip}>
                        <div
                          role="img"
                          aria-label={tooltip}
                          className={cn(
                            "size-6 rounded-sm",
                            ACTIVITY_INTENSITY_CLASSES[intensity],
                            day.date === calendar.todayDate &&
                              "ring-1 ring-primary ring-offset-1 ring-offset-card"
                          )}
                        />
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2 flex items-center text-[10px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>{t("insights.activityLess")}</span>
            <div className="flex items-center gap-1" aria-hidden="true">
              {ACTIVITY_INTENSITY_CLASSES.slice(1).map((className) => (
                <span key={className} className={cn("size-3 rounded-sm", className)} />
              ))}
            </div>
            <span>{t("insights.activityMore")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  largeValue = false,
}: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  detail: string;
  largeValue?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/40 dark:border-white/8 bg-card/70 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon size={14} />
        <span className="text-xs">{label}</span>
      </div>
      <p
        className={cn(
          "mt-3 font-semibold tracking-tight text-foreground",
          largeValue ? "text-3xl" : "text-2xl"
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground/70">{detail}</p>
    </div>
  );
}

export default function InsightsView() {
  const { t, i18n } = useTranslation();
  const { isSignedIn, isLoaded } = useAuth();
  const { dataRetentionEnabled: personalDataRetentionEnabled, insightsSyncEnabled } = useSettings();
  const dataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, personalDataRetentionEnabled)
  );
  const { enableInsightsSync, optInDialog, syncAllowedByPolicy, unclaimedCount } =
    useInsightsSyncOptIn();
  // A managed workspace that forbids cloud backup forbids these counters with
  // it, so the view stays device-scoped even with the preference left on.
  const syncActive =
    isSignedIn && insightsSyncEnabled && syncAllowedByPolicy && dataRetentionEnabled;
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Every dictation broadcasts analytics-changed, so loads overlap; only the
  // newest one may write state, or a slow reply overwrites a fresher summary.
  // A superseded load also bails before syncing, so two passes cannot share a
  // batch and leave the winner reading a summary the other has not finished.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setSyncError(false);

    // The device read stands on its own. Folding it into the same catch as the
    // cloud fetch meant a failed local read fell through to a summary of
    // zeros — under a confident "On this device", with no error anywhere — and
    // told the user their history was empty.
    let local: AnalyticsSummary;
    try {
      local = await window.electronAPI.getAnalyticsSummary();
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error("Reading local Insights failed:", error);
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    if (requestId !== requestIdRef.current) return;
    setLoadFailed(false);

    try {
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
      // Real device data, and the pill says the cloud is the part that failed.
      setSummary(local);
      setSyncError(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [isLoaded, syncActive]);

  useEffect(() => subscribeToAnalyticsRefresh(load, syncActive), [load, syncActive]);

  // i18n.language, not the runtime default: the OS locale is not the language
  // the app is being read in, so a Japanese UI rendered 12.3K where 1.2万
  // belongs, next to correctly localized month labels in the same card.
  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }),
    [i18n.language]
  );

  if (loadFailed) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="rounded-lg border border-border bg-card/50 backdrop-blur-sm dark:bg-card/60">
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">{t("insights.loadError")}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              {t("common.retry")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="rounded-lg border border-border bg-card/50 backdrop-blur-sm dark:bg-card/60">
          <div className="flex items-center justify-center gap-2 py-8">
            <Loader2 size={14} className="animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base! font-semibold! leading-none! tracking-normal! text-foreground">
            {t("insights.title")}
          </h1>
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

      {summary.totalDictations === 0 ? (
        <div className="rounded-lg border border-border bg-card/50 backdrop-blur-sm dark:bg-card/60">
          <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
            <BarChart3 size={40} className="mb-4 text-foreground/15" aria-hidden="true" />
            <h2 className="text-sm font-medium text-foreground">{t("insights.emptyTitle")}</h2>
            <p className="mt-1.5 max-w-sm text-xs text-muted-foreground">
              {t("insights.emptyBody")}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              icon={Mic2}
              label={t("insights.wordsSpoken")}
              value={number.format(summary.totalWords)}
              detail={t("insights.allTime")}
              largeValue
            />
            <MetricCard
              icon={Gauge}
              label={t("insights.wordsPerMinute")}
              value={summary.averageWpm == null ? "—" : number.format(summary.averageWpm)}
              detail={t("insights.wpmCoverage", { count: summary.wpmCoveragePercent })}
              largeValue
            />
            <MetricCard
              icon={BarChart3}
              label={t("insights.dictations")}
              value={number.format(summary.totalDictations)}
              detail={t("insights.allTime")}
              largeValue
            />
            <MetricCard
              icon={Flame}
              label={t("insights.currentStreak")}
              value={t("insights.days", { count: summary.currentStreakDays })}
              detail={t("insights.longestStreak", { count: summary.longestStreakDays })}
            />
          </div>

          <div className="mt-5 rounded-2xl border border-border/50 bg-card/70 px-5 py-2.5 dark:border-white/8">
            <h2 className="text-base font-medium text-foreground">{t("insights.activity")}</h2>
            <div className="mt-2">
              <Heatmap daily={summary.daily} />
            </div>
          </div>
        </>
      )}

      {optInDialog}
    </div>
  );
}
