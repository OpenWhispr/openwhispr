import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, Loader2, Unlink } from "../icons";
import { CALENDAR_LOOKBACK_DAYS } from "../../helpers/calendarCacheWindow";
import { useUiLocale } from "../../hooks/useUiLocale";
import { formatEventWhen } from "../../utils/dateFormatting";
import {
  eventsOnDay,
  startsBeforeStoredWindow,
  searchLinkableEvents,
} from "../../utils/noteEventPicker";
import type { LinkableCalendarEvent } from "../../types/calendar";

interface NoteEventPickerProps {
  /** null while loading */
  events: LinkableCalendarEvent[] | null;
  loadFailed: boolean;
  calendarConnected: boolean;
  noteDay: Date;
  linkedEventId: string | null;
  onSelect: (event: LinkableCalendarEvent) => void;
  onRemove: () => void;
  onBack: () => void;
}

const ROW_CLASS =
  "flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-start text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer";

export function EventDot({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden="true"
      className={
        color
          ? "size-2.5 shrink-0 rounded-[3px]"
          : "size-2.5 shrink-0 rounded-[3px] bg-foreground/30"
      }
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

export default function NoteEventPicker({
  events,
  loadFailed,
  calendarConnected,
  noteDay,
  linkedEventId,
  onSelect,
  onRemove,
  onBack,
}: NoteEventPickerProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const [query, setQuery] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  const rows = useMemo(() => {
    if (!events) return [];
    return searching ? searchLinkableEvents(events, query, noteDay) : eventsOnDay(events, noteDay);
  }, [events, noteDay, query, searching]);

  let emptyState: { message: string; hint?: string } | null = null;
  if (!calendarConnected) {
    emptyState = { message: t("notes.eventLink.noCalendar") };
  } else if (loadFailed) {
    emptyState = { message: t("notes.eventLink.loadFailed") };
  } else if (events && rows.length === 0) {
    if (searching) {
      emptyState = { message: t("notes.eventLink.noResults") };
    } else {
      emptyState = {
        message: startsBeforeStoredWindow(noteDay)
          ? t("notes.eventLink.outsideWindow", { days: CALENDAR_LOOKBACK_DAYS })
          : t("notes.eventLink.noEventsOnDay"),
        hint: t("notes.eventLink.searchOtherDays"),
      };
    }
  }
  const loading = calendarConnected && !loadFailed && events === null;

  // Arrow keys walk the search box and the rows; Enter in a search picks the first match.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      if (!searching || rows.length === 0) return;
      event.preventDefault();
      onSelect(rows[0]);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      pickerRef.current?.querySelectorAll<HTMLElement>("input, [data-event-row]") ?? []
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[Math.max(0, Math.min(items.length - 1, next))].focus();
  };

  return (
    <div ref={pickerRef} onKeyDown={handleKeyDown}>
      <div className="flex items-center gap-1 p-2 border-b border-border/70">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("notes.eventLink.back")}
          className="shrink-0 p-1 rounded-md text-foreground/50 hover:bg-foreground/5 hover:text-foreground/70 transition-colors cursor-pointer"
        >
          <ChevronLeft size={14} className="rtl:rotate-180" />
        </button>
        <input
          dir="auto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("notes.eventLink.searchPlaceholder")}
          aria-label={t("notes.eventLink.searchPlaceholder")}
          className="w-full px-1 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/45 outline-none border-none appearance-none"
          autoFocus
        />
      </div>

      <div className="max-h-64 overflow-y-auto p-1">
        {linkedEventId && (
          <button type="button" onClick={onRemove} data-event-row className={ROW_CLASS}>
            <Unlink size={14} className="shrink-0 text-foreground/50" />
            <span>{t("notes.eventLink.removeEvent")}</span>
          </button>
        )}

        {rows.map((event) => (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelect(event)}
            aria-current={event.id === linkedEventId || undefined}
            data-event-row
            className={ROW_CLASS}
          >
            <EventDot color={event.calendar_color} />
            <span className="flex-1 min-w-0">
              <span dir="auto" className="block truncate text-foreground/80">
                {event.summary || t("upcoming.untitledEvent")}
              </span>
              <span className="block truncate text-[11px] text-foreground/45">
                {formatEventWhen(event, locale, t("notes.eventLink.allDay"))}
              </span>
            </span>
            {event.id === linkedEventId && (
              <Check size={14} className="shrink-0 text-primary" aria-hidden="true" />
            )}
          </button>
        ))}

        {loading && (
          <div
            role="status"
            className="flex items-center justify-center gap-1.5 px-3 py-4 text-[11px] text-foreground/45"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            {t("common.loading")}
          </div>
        )}

        {emptyState && (
          <div className="px-3 py-4 text-center text-[11px] text-foreground/45">
            <p>{emptyState.message}</p>
            {emptyState.hint && <p className="mt-1">{emptyState.hint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
