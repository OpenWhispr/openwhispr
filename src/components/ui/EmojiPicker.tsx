import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "../icons";
import { Button } from "./button";
import { PopoverContent } from "./popover";
import { getSupportedEmojiVersion, loadEmojiData } from "../../lib/emojiData";
import {
  EMOJI_GROUP_KEYS,
  buildEmojiRows,
  emojiAt,
  firstEmojiPosition,
  groupEmoji,
  isArrowKey,
  logicalArrowKey,
  moveEmojiPosition,
  pushRecentEmoji,
  searchEmoji,
  visibleEmoji,
  type EmojiData,
  type EmojiRow,
  type GridPosition,
} from "../../lib/emojiPicker";
import { getCachedPlatform } from "../../utils/platform";
import { cn } from "../lib/utils";

const RECENT_STORAGE_KEY = "recentEmoji";
const CELL_SIZE = 32;
const HEADER_HEIGHT = 28;
// Eight emoji rows plus a header, fixed so the panel holds still while data loads.
const VIEWPORT_HEIGHT = CELL_SIZE * 8 + HEADER_HEIGHT;

function readRecentEmoji(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function rowKey(row: EmojiRow, index: number): string {
  return `${index}:${row.kind === "header" ? row.title : row.items[0].emoji}`;
}

interface EmojiPickerContentProps {
  value: string | null;
  /** `null` when the user removes the current emoji. */
  onSelect: (emoji: string | null) => void;
}

// Searchable, categorised emoji grid rendered inside a Popover. Hosts own the
// Popover's open state and close it from `onSelect`.
export function EmojiPickerContent(props: EmojiPickerContentProps) {
  // PopoverContent only renders children while open, so the panel's data
  // loading and row building don't run for every closed picker on the page.
  return (
    <PopoverContent className="w-auto min-w-0 overflow-hidden p-0">
      <EmojiPickerPanel {...props} />
    </PopoverContent>
  );
}

function EmojiPickerPanel({ value, onSelect }: EmojiPickerContentProps) {
  const { t, i18n } = useTranslation();
  const gridId = useId();
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecentEmoji);
  const [active, setActive] = useState<GridPosition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadEmojiData(i18n.language).then((loaded) => {
      if (!cancelled) setData(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [i18n.language]);

  const rows = useMemo<EmojiRow[]>(() => {
    if (!data) return [];
    const entries = visibleEmoji(data.emoji, {
      maxVersion: getSupportedEmojiVersion(data.emoji),
      hideRegionalFlags: getCachedPlatform() === "win32",
    });
    if (query.trim()) return buildEmojiRows([{ title: null, items: searchEmoji(entries, query) }]);
    const byEmoji = new Map(entries.map((entry) => [entry.emoji, entry]));
    const groupNames = Object.fromEntries(
      Object.entries(EMOJI_GROUP_KEYS).map(([group, key]) => [
        group,
        t(`emojiPicker.groups.${key}`),
      ])
    );
    return buildEmojiRows([
      {
        title: t("emojiPicker.recent"),
        items: recent.flatMap((emoji) => byEmoji.get(emoji) ?? []),
      },
      ...groupEmoji(entries, groupNames),
    ]);
  }, [data, query, recent, t]);

  const activePosition = active ?? firstEmojiPosition(rows);
  const activeCellId = `${gridId}-active`;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].kind === "header" ? HEADER_HEIGHT : CELL_SIZE),
    getItemKey: (index) => rowKey(rows[index], index),
    overscan: 6,
  });

  const select = (emoji: string) => {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(pushRecentEmoji(recent, emoji)));
    onSelect(emoji);
  };

  const onQueryChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setActive(null);
    virtualizer.scrollToOffset(0);
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      const entry = activePosition && emojiAt(rows, activePosition);
      if (entry) {
        event.preventDefault();
        select(entry.emoji);
      }
      return;
    }
    if (!isArrowKey(event.key) || !activePosition) return;
    event.preventDefault();
    const next = moveEmojiPosition(rows, activePosition, logicalArrowKey(event.key, i18n.dir()));
    setActive(next);
    // Moving up onto a section's first row also brings its header into view.
    const movingUp = next.row < activePosition.row;
    virtualizer.scrollToIndex(
      movingUp && rows[next.row - 1]?.kind === "header" ? next.row - 1 : next.row
    );
  };

  return (
    <>
      <div className="flex h-9 items-center gap-2 border-b border-border px-3">
        <Search size={14} className="shrink-0 text-muted-foreground/70" />
        <input
          dir="auto"
          type="text"
          value={query}
          onChange={onQueryChange}
          onKeyDown={onSearchKeyDown}
          placeholder={t("emojiPicker.search")}
          aria-label={t("emojiPicker.search")}
          aria-controls={gridId}
          aria-activedescendant={activePosition ? activeCellId : undefined}
          className="input-inline min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      <div
        ref={scrollRef}
        id={gridId}
        role="grid"
        className="emoji-picker-scroll w-[312px] overflow-y-auto px-2 py-1"
        style={{ height: VIEWPORT_HEIGHT }}
      >
        {data && rows.length === 0 ? (
          <p className="pt-10 text-center text-xs text-muted-foreground">
            {t("emojiPicker.noResults")}
          </p>
        ) : (
          <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={item.key}
                  role={row.kind === "emoji" ? "row" : "presentation"}
                  className="absolute inset-x-0 flex"
                  style={{ top: item.start, height: item.size }}
                >
                  {row.kind === "header" ? (
                    <div className="self-end pb-1 ps-1 text-xs font-medium text-muted-foreground">
                      {row.title}
                    </div>
                  ) : (
                    row.items.map((entry, col) => {
                      const isActive =
                        activePosition?.row === item.index && activePosition.col === col;
                      return (
                        <button
                          key={entry.emoji}
                          type="button"
                          role="gridcell"
                          tabIndex={-1}
                          id={isActive ? activeCellId : undefined}
                          aria-selected={isActive}
                          aria-label={entry.label}
                          onMouseEnter={() => setActive({ row: item.index, col })}
                          onClick={() => select(entry.emoji)}
                          className={cn(
                            "font-emoji flex size-8 items-center justify-center rounded-md text-[20px] leading-none transition-colors duration-100",
                            isActive && "bg-foreground/8 dark:bg-white/10"
                          )}
                        >
                          {entry.emoji}
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {value && (
        <div className="flex justify-end border-t border-border px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
            {t("emojiPicker.remove")}
          </Button>
        </div>
      )}
    </>
  );
}
