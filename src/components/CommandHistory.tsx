import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Terminal,
  Trash2,
  Copy,
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Clock,
  BarChart3,
  Filter,
} from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tooltip } from "./ui/tooltip";
import { ConfirmDialog } from "./ui/dialog";
import { useToast } from "./ui/Toast";
import { cn } from "./lib/utils";
import { normalizeDbDate, formatDateGroup } from "../utils/dateFormatting";
import type { CommandLogItem, CommandStats } from "../types/electron";

const PAGE_SIZE = 50;

/** Format a duration in milliseconds to a human-readable string like "2.5s" or "150ms". */
function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "--";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Get a relative time label like "2 hours ago". */
function relativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return t("commandHistory.timeJustNow");
  if (minutes < 60) return t("commandHistory.timeMinutesAgo", { count: minutes });
  if (hours < 24) return t("commandHistory.timeHoursAgo", { count: hours });
  if (days < 7) return t("commandHistory.timeDaysAgo", { count: days });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Map a provider string to a badge variant. */
function providerBadgeVariant(
  provider: string | null
): "default" | "secondary" | "outline" | "success" | "warning" | "info" {
  if (!provider) return "outline";
  const p = provider.toLowerCase();
  if (p.includes("whisper")) return "default";
  if (p.includes("openai") || p.includes("openwhispr")) return "info";
  if (p.includes("nvidia") || p.includes("parakeet")) return "success";
  if (p.includes("assembly")) return "warning";
  if (p.includes("deepgram")) return "warning";
  return "secondary";
}

export default function CommandHistory() {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Data state
  const [commands, setCommands] = useState<CommandLogItem[]>([]);
  const [stats, setStats] = useState<CommandStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  // UI state
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  // Refs
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offsetRef = useRef(0);

  // ---- Data fetching ----

  const loadCommands = useCallback(
    async (reset = true) => {
      if (reset) {
        setIsLoading(true);
        offsetRef.current = 0;
      } else {
        setIsLoadingMore(true);
      }

      try {
        let results: CommandLogItem[];

        if (searchQuery.trim()) {
          results = await window.electronAPI.searchCommandHistory!(
            searchQuery.trim(),
            PAGE_SIZE
          );
          setHasMore(false); // search returns all results
        } else {
          results = await window.electronAPI.getCommandHistory!({
            limit: PAGE_SIZE,
            offset: reset ? 0 : offsetRef.current,
            status: statusFilter !== "all" ? statusFilter : undefined,
            provider: providerFilter !== "all" ? providerFilter : undefined,
            source: sourceFilter !== "all" ? sourceFilter : undefined,
          });
          setHasMore(results.length === PAGE_SIZE);
        }

        if (reset) {
          setCommands(results);
          offsetRef.current = results.length;
        } else {
          setCommands((prev) => [...prev, ...results]);
          offsetRef.current += results.length;
        }
      } catch {
        toast({
          title: t("commandHistory.loadError"),
          variant: "destructive",
          duration: 3000,
        });
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [searchQuery, statusFilter, providerFilter, sourceFilter, toast, t]
  );

  const loadStats = useCallback(async () => {
    try {
      const result = await window.electronAPI.getCommandStats!();
      setStats(result);
    } catch {
      // stats are non-critical, silently fail
    }
  }, []);

  const isInitialMount = useRef(true);

  // Load stats on mount
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Load commands on mount and whenever search/filters change (debounced after first load)
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (isInitialMount.current) {
      isInitialMount.current = false;
      loadCommands(true);
      return;
    }

    searchTimerRef.current = setTimeout(() => {
      loadCommands(true);
    }, 250);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, statusFilter, providerFilter, sourceFilter]);

  // ---- Actions ----

  const handleDeleteCommand = useCallback(
    async (id: number) => {
      try {
        const result = await window.electronAPI.deleteCommandLog!(id);
        if (result.success) {
          setCommands((prev) => prev.filter((c) => c.id !== id));
          loadStats();
        }
      } catch {
        toast({
          title: t("commandHistory.deleteError"),
          variant: "destructive",
        });
      }
    },
    [toast, t, loadStats]
  );

  const handleClearAll = useCallback(async () => {
    try {
      const result = await window.electronAPI.clearCommandHistory!();
      if (result.success) {
        setCommands([]);
        setStats(null);
        loadStats();
        toast({
          title: t("commandHistory.clearSuccess"),
          variant: "success",
          duration: 2000,
        });
      }
    } catch {
      toast({
        title: t("commandHistory.clearError"),
        variant: "destructive",
      });
    }
  }, [toast, t, loadStats]);

  const handleCopyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t("commandHistory.copiedToClipboard"),
          variant: "success",
          duration: 1500,
        });
      } catch {
        toast({
          title: t("commandHistory.copyError"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const handleExport = useCallback(
    async (format: "json" | "csv") => {
      try {
        const result = await window.electronAPI.exportCommandHistory!({});
        if (result.success && result.data) {
          let content: string;
          let mimeType: string;
          let extension: string;

          if (format === "json") {
            content = JSON.stringify(result.data, null, 2);
            mimeType = "application/json";
            extension = "json";
          } else {
            const headers = [
              "id",
              "command_text",
              "provider",
              "status",
              "source",
              "duration_ms",
              "created_at",
            ];
            const rows = result.data.map((item) =>
              headers
                .map((h) => {
                  const val = item[h as keyof CommandLogItem];
                  const str = val === null || val === undefined ? "" : String(val);
                  return `"${str.replace(/"/g, '""')}"`;
                })
                .join(",")
            );
            content = [headers.join(","), ...rows].join("\n");
            mimeType = "text/csv";
            extension = "csv";
          }

          const blob = new Blob([content], { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `command-history.${extension}`;
          a.click();
          URL.revokeObjectURL(url);

          toast({
            title: t("commandHistory.exportSuccess"),
            variant: "success",
            duration: 2000,
          });
        }
      } catch {
        toast({
          title: t("commandHistory.exportError"),
          variant: "destructive",
        });
      }
    },
    [toast, t]
  );

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ---- Grouping by date ----

  const groupedCommands = useMemo(() => {
    if (commands.length === 0) return [];
    const groups: { label: string; items: CommandLogItem[] }[] = [];
    let currentLabel: string | null = null;

    for (const item of commands) {
      const label = formatDateGroup(item.created_at, t);
      if (label !== currentLabel) {
        groups.push({ label, items: [item] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(item);
      }
    }
    return groups;
  }, [commands, t]);

  // ---- Unique providers/sources for filter dropdowns ----

  const availableProviders = useMemo(() => {
    const set = new Set<string>();
    commands.forEach((c) => {
      if (c.provider) set.add(c.provider);
    });
    return [...set].sort();
  }, [commands]);

  const availableSources = useMemo(() => {
    const set = new Set<string>();
    commands.forEach((c) => {
      if (c.source) set.add(c.source);
    });
    return [...set].sort();
  }, [commands]);

  const hasActiveFilters =
    statusFilter !== "all" || providerFilter !== "all" || sourceFilter !== "all";

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog
        open={confirmClearAll}
        onOpenChange={setConfirmClearAll}
        title={t("commandHistory.clearAllTitle")}
        description={t("commandHistory.clearAllDescription")}
        onConfirm={handleClearAll}
        variant="destructive"
      />

      <div className="px-5 pt-4 pb-3">
        <div className="max-w-3xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-foreground">
                {t("commandHistory.title")}
              </h2>
              {stats && stats.total > 0 && (
                <span className="text-xs text-foreground/15 font-mono tabular-nums">
                  {stats.total}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {commands.length > 0 && (
                <>
                  <Tooltip content={t("commandHistory.exportJson")}>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleExport("json")}
                      className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground"
                    >
                      <Download size={12} />
                    </Button>
                  </Tooltip>
                  <button
                    onClick={() => setConfirmClearAll(true)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground/60 hover:text-destructive hover:bg-destructive/8 dark:hover:bg-destructive/10 transition-all duration-200"
                  >
                    <Trash2 size={11} />
                    <span>{t("commandHistory.clearAll")}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Stats summary */}
          {stats && stats.total > 0 && (
            <div className="flex items-center gap-4 mb-3 px-3 py-2 rounded-lg border border-border/20 dark:border-border-subtle/30 bg-card/30 dark:bg-surface-2/30">
              <div className="flex items-center gap-1.5">
                <BarChart3 size={11} className="text-muted-foreground/50" />
                <span className="text-[11px] text-muted-foreground">
                  {t("commandHistory.statsTotal", { count: stats.total })}
                </span>
              </div>
              {stats.avgDurationMs !== null && (
                <div className="flex items-center gap-1.5">
                  <Clock size={11} className="text-muted-foreground/50" />
                  <span className="text-[11px] text-muted-foreground">
                    {t("commandHistory.statsAvgDuration", {
                      duration: formatDuration(stats.avgDurationMs),
                    })}
                  </span>
                </div>
              )}
              {stats.mostUsedProvider && (
                <div className="flex items-center gap-1.5">
                  <Badge
                    variant={providerBadgeVariant(stats.mostUsedProvider)}
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {stats.mostUsedProvider}
                  </Badge>
                </div>
              )}
              {stats.failed > 0 && (
                <div className="flex items-center gap-1.5">
                  <XCircle size={11} className="text-destructive/60" />
                  <span className="text-[11px] text-destructive/70">
                    {t("commandHistory.statsFailed", { count: stats.failed })}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Search and filters */}
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <Search
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40"
              />
              <Input
                placeholder={t("commandHistory.searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-7 text-xs pl-7 pr-2 placeholder:text-foreground/20"
              />
            </div>
          </div>

          {/* Filter row */}
          <div className="flex items-center gap-2 mb-3">
            <Filter size={11} className="text-muted-foreground/40 shrink-0" />

            {/* Status filter */}
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "all", label: t("commandHistory.filterAll") },
                { value: "completed", label: t("commandHistory.filterCompleted") },
                { value: "failed", label: t("commandHistory.filterFailed") },
              ]}
            />

            {/* Provider filter */}
            <FilterSelect
              value={providerFilter}
              onChange={setProviderFilter}
              options={[
                { value: "all", label: t("commandHistory.filterAllProviders") },
                ...availableProviders.map((p) => ({ value: p, label: p })),
              ]}
            />

            {/* Source filter */}
            <FilterSelect
              value={sourceFilter}
              onChange={setSourceFilter}
              options={[
                { value: "all", label: t("commandHistory.filterAllSources") },
                ...availableSources.map((s) => ({ value: s, label: s })),
              ]}
            />

            {hasActiveFilters && (
              <button
                onClick={() => {
                  setStatusFilter("all");
                  setProviderFilter("all");
                  setSourceFilter("all");
                }}
                className="text-[10px] text-primary hover:text-primary/80 transition-colors whitespace-nowrap"
              >
                {t("commandHistory.clearFilters")}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="mx-5 h-px bg-border/8 dark:bg-white/3" />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-3">
        <div className="max-w-3xl mx-auto">
          {isLoading ? (
            <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 size={14} className="animate-spin text-primary" />
                <span className="text-sm text-muted-foreground">
                  {t("commandHistory.loading")}
                </span>
              </div>
            </div>
          ) : commands.length === 0 ? (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center py-16 px-4">
              <div className="w-10 h-10 rounded-[10px] bg-gradient-to-b from-primary/8 to-primary/4 dark:from-primary/12 dark:to-primary/6 border border-primary/10 dark:border-primary/15 flex items-center justify-center mb-4">
                <Terminal
                  size={17}
                  strokeWidth={1.5}
                  className="text-primary/50 dark:text-primary/60"
                />
              </div>
              <h3 className="text-xs font-semibold text-foreground/70 dark:text-foreground/60 mb-1.5">
                {hasActiveFilters || searchQuery.trim()
                  ? t("commandHistory.noResults")
                  : t("commandHistory.emptyTitle")}
              </h3>
              <p className="text-xs text-foreground/30 text-center leading-relaxed max-w-[240px]">
                {hasActiveFilters || searchQuery.trim()
                  ? t("commandHistory.noResultsDescription")
                  : t("commandHistory.emptyDescription")}
              </p>
            </div>
          ) : (
            /* Command list */
            <div className="group">
              {groupedCommands.map((group, groupIndex) => (
                <div key={group.label} className={groupIndex > 0 ? "mt-4" : ""}>
                  <div className="sticky -top-3 z-10 -mx-5 px-6 pt-2 pb-2 bg-background">
                    <span className="text-[11px] font-semibold text-muted-foreground dark:text-muted-foreground uppercase tracking-wide">
                      {group.label}
                    </span>
                  </div>
                  <div className="space-y-1.5 relative z-0">
                    {group.items.map((item) => (
                      <CommandEntry
                        key={item.id}
                        item={item}
                        isExpanded={expandedIds.has(item.id)}
                        onToggleExpand={() => toggleExpanded(item.id)}
                        onCopy={handleCopyText}
                        onDelete={handleDeleteCommand}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              ))}

              {/* Load more button */}
              {hasMore && !searchQuery.trim() && (
                <div className="flex justify-center py-4">
                  <Button
                    variant="outline-flat"
                    size="sm"
                    onClick={() => loadCommands(false)}
                    disabled={isLoadingMore}
                    className="h-7 text-xs gap-1.5"
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 size={11} className="animate-spin" />
                        {t("commandHistory.loadingMore")}
                      </>
                    ) : (
                      <>
                        <ChevronDown size={11} />
                        {t("commandHistory.loadMore")}
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Sub-components ----

/** A compact inline filter select matching the app's style. */
function FilterSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-6 text-[11px] rounded-md border border-border/30 dark:border-white/8",
        "bg-foreground/3 dark:bg-white/3 text-foreground/70 dark:text-foreground/60",
        "hover:bg-foreground/5 dark:hover:bg-white/5",
        "focus:outline-none focus:ring-1 focus:ring-primary/20",
        "px-2 py-0 cursor-pointer transition-colors",
        value !== "all" && "border-primary/30 text-primary dark:text-primary"
      )}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

/** A single command history entry. */
function CommandEntry({
  item,
  isExpanded,
  onToggleExpand,
  onCopy,
  onDelete,
  t,
}: {
  item: CommandLogItem;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const isFailed = item.status === "failed";
  const commandText = item.command_text;
  const isLong = commandText.length > 120;
  const displayText = isExpanded || !isLong ? commandText : `${commandText.slice(0, 120)}...`;

  return (
    <div
      className={cn(
        "group/entry rounded-md border px-3 py-2.5 transition-colors duration-150",
        isFailed
          ? "border-destructive/30 bg-destructive/5 hover:bg-destructive/10"
          : "border-border/40 dark:border-border-subtle/60 bg-card/50 dark:bg-surface-2/60 hover:bg-muted/30 dark:hover:bg-surface-2/80"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-start gap-3">
        {/* Status indicator */}
        <div className="shrink-0 pt-0.5">
          {isFailed ? (
            <XCircle size={13} className="text-destructive/70" />
          ) : (
            <CheckCircle2 size={13} className="text-success/60" />
          )}
        </div>

        {/* Command text */}
        <div className="flex-1 min-w-0">
          <p
            className={cn(
              "text-sm leading-[1.5] break-words",
              isFailed ? "text-destructive/80" : "text-foreground"
            )}
          >
            {displayText}
          </p>
          {isLong && (
            <button
              onClick={onToggleExpand}
              className="text-[10px] text-primary/60 hover:text-primary transition-colors mt-0.5"
            >
              {isExpanded
                ? t("commandHistory.showLess")
                : t("commandHistory.showMore")}
            </button>
          )}

          {/* Metadata row */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground/50 tabular-nums">
              {relativeTime(item.created_at, t)}
            </span>

            {item.provider && (
              <Badge
                variant={providerBadgeVariant(item.provider)}
                className="px-1.5 py-0 text-[9px] leading-[16px]"
              >
                {item.provider}
              </Badge>
            )}

            {item.duration_ms !== null && (
              <span className="text-[10px] text-muted-foreground/40 tabular-nums flex items-center gap-0.5">
                <Clock size={9} />
                {formatDuration(item.duration_ms)}
              </span>
            )}

            {item.source && (
              <span className="text-[10px] text-muted-foreground/35">
                {item.source}
              </span>
            )}

            {isFailed && item.error_message && (
              <span className="text-[10px] text-destructive/60 truncate max-w-[200px]">
                {item.error_message}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div
          className={cn(
            "flex items-center gap-0.5 shrink-0 transition-opacity duration-150",
            isHovered ? "opacity-100" : "opacity-0"
          )}
        >
          {!isFailed && (
            <Tooltip content={t("commandHistory.copyText")}>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => onCopy(commandText)}
                className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
              >
                <Copy size={12} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={t("commandHistory.deleteEntry")}>
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
    </div>
  );
}
