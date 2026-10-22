import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpDown, Check, RefreshCw, Search, X } from "../icons";
import { Input } from "../ui/input";
import { Tooltip } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { SORT_LABEL_KEYS, type SortKey } from "./dictionaryViewModel";

const SORT_KEYS = Object.keys(SORT_LABEL_KEYS) as SortKey[];

interface DictionaryToolbarProps {
  search: string;
  onSearchChange: (search: string) => void;
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  showSync: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
  onSync: () => void;
}

// How often "Synced N min ago" is reworded, so an open tooltip doesn't go stale.
const SYNCED_LABEL_REFRESH_MS = 30_000;

const ICON_BUTTON_CLASS =
  "grid size-[26px] place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 dark:hover:bg-white/6";

function syncedLabel(
  lastSyncedAt: string | null,
  t: (key: string, options?: Record<string, unknown>) => string,
  language: string
): string {
  const time = lastSyncedAt ? Date.parse(lastSyncedAt) : Number.NaN;
  if (Number.isNaN(time)) return t("dictionary.shared.toolbar.notSynced");
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return t("dictionary.shared.toolbar.syncedJustNow");
  const [value, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 1440
        ? [Math.floor(minutes / 60), "hour"]
        : [Math.floor(minutes / 1440), "day"];
  const amount = new Intl.NumberFormat(language, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(value);
  return t("dictionary.shared.toolbar.syncedAgo", { time: amount });
}

function ToolButton({
  label,
  tooltip,
  onClick,
  active,
  children,
}: {
  label: string;
  tooltip?: string;
  onClick?: () => void;
  active?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <Tooltip content={tooltip ?? label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={cn(ICON_BUTTON_CLASS, active && "bg-card text-foreground shadow-sm")}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function DictionaryToolbar({
  search,
  onSearchChange,
  sort,
  onSortChange,
  showSync,
  syncing,
  lastSyncedAt,
  onSync,
}: DictionaryToolbarProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(search !== "");
  const [, setLabelTick] = useState(0);

  useEffect(() => {
    if (!showSync) return;
    const timer = setInterval(() => setLabelTick((tick) => tick + 1), SYNCED_LABEL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [showSync]);

  const closeSearch = (): void => {
    setSearchOpen(false);
    onSearchChange("");
  };

  return (
    <div className="flex items-center gap-1">
      {searchOpen ? (
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute start-2 top-1/2 -translate-y-1/2 text-foreground/40"
          />
          <Input
            dir="auto"
            autoFocus
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeSearch();
            }}
            placeholder={t("dictionary.shared.toolbar.searchPlaceholder")}
            aria-label={t("dictionary.shared.toolbar.search")}
            className="h-[26px] w-44 rounded-md ps-6 pe-6 text-xs"
          />
          <button
            type="button"
            onClick={closeSearch}
            aria-label={t("dictionary.shared.toolbar.closeSearch")}
            className="absolute end-1.5 top-1/2 -translate-y-1/2 text-foreground/40 hover:text-foreground/70"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <ToolButton
          label={t("dictionary.shared.toolbar.search")}
          onClick={() => setSearchOpen(true)}
        >
          <Search size={14} />
        </ToolButton>
      )}

      <DropdownMenu>
        <Tooltip content={t("dictionary.shared.toolbar.sort")}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("dictionary.shared.toolbar.sort")}
              className={ICON_BUTTON_CLASS}
            >
              <ArrowUpDown size={14} />
            </button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-36 rounded-lg p-1">
          {SORT_KEYS.map((key) => (
            <DropdownMenuItem
              key={key}
              onSelect={() => onSortChange(key)}
              className="gap-2 rounded-md px-2 py-1.5 text-xs"
            >
              <span className="flex-1">{t(SORT_LABEL_KEYS[key])}</span>
              {key === sort && <Check size={12} className="text-primary" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {showSync && (
        <ToolButton
          label={t("dictionary.shared.toolbar.sync")}
          tooltip={syncedLabel(lastSyncedAt, t, i18n.language)}
          onClick={syncing ? undefined : onSync}
        >
          <RefreshCw size={14} className={cn(syncing && "animate-spin")} />
        </ToolButton>
      )}
    </div>
  );
}
