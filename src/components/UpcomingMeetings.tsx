import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ExternalLink, Loader2, Mic, Monitor, Video } from "./icons";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import PersonAvatar from "./ui/PersonAvatar";
import { cn } from "./lib/utils";
import type { CalendarAttendee, CalendarEvent } from "../types/calendar";
import { parseAttendees } from "../utils/calendarAttendees";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../utils/systemAudioAccess";
import { getMeetingJoinUrl } from "../helpers/meetingJoinUrl";
import { parseEventDate } from "../utils/dateFormatting";

interface UpcomingMeetingsProps {
  events: CalendarEvent[];
  isLoading: boolean;
  isConnected: boolean;
  onConnectCalendar: () => void;
}

const openJoinUrl = (url: string) => {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
};

function formatTimeRange(locale: string, startTime: string, endTime: string): string {
  const format = (value: string) =>
    new Date(value).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `${format(startTime)} – ${format(endTime)}`;
}

// Today plus the next days that have events, capped at a working week.
const MAX_DAY_CARDS = 5;
// Avatars shown before the "+N" overflow pill.
const MAX_STACKED_AVATARS = 2;

interface DayGroup {
  key: string;
  date: Date;
  isToday: boolean;
  items: CalendarEvent[];
}

function groupEventsByDay(events: CalendarEvent[], now: Date): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const event of events) {
    const date = parseEventDate(event.start_time);
    if (!date) continue;
    const key = date.toDateString();
    let group = byKey.get(key);
    if (!group) {
      group = { key, date, isToday: key === now.toDateString(), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(event);
  }
  // Surface "today" even when it has nothing scheduled, so the list always
  // answers "what's next today?" at a glance.
  if (groups.length > 0 && !groups.some((g) => g.isToday)) {
    groups.unshift({ key: now.toDateString(), date: now, isToday: true, items: [] });
  }
  return groups.slice(0, MAX_DAY_CARDS);
}

const ATTENDEE_COUNT_PILL_CLASS =
  "flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface-3 px-0.5 text-[9px] font-medium tabular-nums text-muted-foreground ring-1 ring-background";

const RSVP_DOT: Record<string, string> = {
  accepted: "bg-green-500",
  declined: "bg-red-400",
  tentative: "bg-amber-400",
};

function AttendeePopover({
  event,
  attendees,
  timeRange,
  joinUrl,
}: {
  event: CalendarEvent;
  attendees: CalendarAttendee[];
  timeRange: string;
  joinUrl: string | null;
}) {
  const { t } = useTranslation();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={`${attendees.length} ${t("notes.participants.attendees")}`}
          className="flex shrink-0 items-center -space-x-1 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring/40"
        >
          {attendees.slice(0, MAX_STACKED_AVATARS).map((a) => (
            <PersonAvatar
              key={a.email}
              email={a.email}
              displayName={a.displayName}
              size={18}
              className="ring-1 ring-background"
            />
          ))}
          {attendees.length > MAX_STACKED_AVATARS && (
            <span className={ATTENDEE_COUNT_PILL_CLASS}>
              +{attendees.length - MAX_STACKED_AVATARS}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border/50 px-3 py-2.5">
          <p dir="auto" className="text-xs font-medium leading-snug text-foreground">
            {event.summary || t("upcoming.untitledEvent")}
          </p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{timeRange}</p>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {attendees.map((a) => (
            <div key={a.email} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <PersonAvatar email={a.email} displayName={a.displayName} />
              <div className="min-w-0 flex-1">
                <p dir="auto" className="truncate text-xs text-foreground/80">
                  {a.displayName || a.email.split("@")[0]}
                  {a.self && (
                    <span className="ms-1 text-foreground/30">{t("notes.participants.me")}</span>
                  )}
                </p>
                <p dir="ltr" className="truncate text-[11px] text-foreground/35">
                  {a.email}
                </p>
              </div>
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  RSVP_DOT[a.responseStatus ?? ""] ?? "bg-muted-foreground/25"
                )}
              />
            </div>
          ))}
        </div>
        {joinUrl && (
          <div className="border-t border-border/50 p-1">
            <button
              onClick={() => openJoinUrl(joinUrl)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground/70 transition-colors hover:bg-foreground/5"
            >
              <ExternalLink size={12} className="shrink-0" />
              {t("upcoming.openMeetingLink")}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EventRow({ event, isNow }: { event: CalendarEvent; isNow: boolean }) {
  const { t, i18n } = useTranslation();
  const joinUrl = getMeetingJoinUrl(event);
  const attendees = useMemo(() => parseAttendees(event), [event]);
  const timeRange = formatTimeRange(i18n.language, event.start_time, event.end_time);

  const startNotes = () => {
    if (joinUrl) openJoinUrl(joinUrl);
    window.electronAPI?.joinCalendarMeeting?.(event.id);
  };

  return (
    <div className="flex items-center gap-3 px-1 py-2">
      {attendees.length > 1 ? (
        <AttendeePopover
          event={event}
          attendees={attendees}
          timeRange={timeRange}
          joinUrl={joinUrl}
        />
      ) : event.attendees_count > 1 ? (
        <span className={ATTENDEE_COUNT_PILL_CLASS}>+{event.attendees_count - 1}</span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p dir="auto" className="truncate text-sm font-medium leading-tight text-foreground">
          {event.summary || t("upcoming.untitledEvent")}
        </p>
        {isNow ? (
          <span className="mt-1 flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
            </span>
            <span className="text-xs font-medium text-green-600 dark:text-green-400">
              {t("upcoming.now")}
            </span>
          </span>
        ) : (
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">{timeRange}</p>
        )}
      </div>
      {isNow && (
        <Button size="sm" onClick={startNotes} className="h-7 shrink-0 gap-1.5 rounded-full px-3">
          {joinUrl ? <Video size={12} /> : <Mic size={12} />}
          {joinUrl ? t("upcoming.joinAndTakeNotes") : t("upcoming.takeNotes")}
        </Button>
      )}
    </div>
  );
}

function DayCard({ group, isNowFn }: { group: DayGroup; isNowFn: (e: CalendarEvent) => boolean }) {
  const { t, i18n } = useTranslation();

  return (
    <div className="overflow-clip rounded-2xl border border-border/70 dark:border-white/10">
      <div
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium",
          group.isToday
            ? "bg-primary text-primary-foreground"
            : "bg-surface-3 text-foreground dark:bg-surface-2"
        )}
      >
        <Calendar size={12} className="shrink-0" />
        <span>
          {group.date.toLocaleDateString(i18n.language, { day: "numeric", month: "short" })}
        </span>
      </div>
      <div className="bg-background px-2 dark:bg-surface-2/60">
        {group.items.length === 0 ? (
          <p className="px-1 py-3 text-xs text-muted-foreground/60">
            {t("upcoming.noEventsToday")}
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {group.items.map((event) => (
              <EventRow key={event.id} event={event} isNow={isNowFn(event)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SidebarCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Calendar;
  title?: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-border/70 bg-card/50 px-4 py-6 text-center dark:border-white/10 dark:bg-surface-2/60">
      <Icon size={20} className="mb-2 text-muted-foreground/40" />
      {title && <p className="text-xs font-medium text-foreground/80">{title}</p>}
      {description && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/60">{description}</p>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export default function UpcomingMeetings({
  events,
  isLoading,
  isConnected,
  onConnectCalendar,
}: UpcomingMeetingsProps) {
  const { t } = useTranslation();
  const systemAudio = useSystemAudioPermission();
  const needsSystemAudioGrant = !systemAudio.granted && canManageSystemAudioInApp(systemAudio);

  const now = useMemo(() => new Date(), []);
  const groupedEvents = useMemo(() => groupEventsByDay(events, now), [events, now]);

  const isNowFn = (event: CalendarEvent) => {
    const start = new Date(event.start_time);
    const end = new Date(event.end_time);
    return start <= now && now <= end;
  };

  return (
    <div>
      <p className="pt-2 pb-2.5 text-sm text-muted-foreground">{t("upcoming.title")}</p>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-6">
          <Loader2 size={14} className="animate-spin text-primary" />
        </div>
      )}

      {/* Calendar not connected */}
      {!isLoading && !isConnected && (
        <SidebarCard
          icon={Calendar}
          title={t("upcoming.connectCalendar")}
          description={t("upcoming.connectCalendarDescription")}
        >
          <Button size="sm" onClick={onConnectCalendar} className="h-7 text-xs">
            {t("upcoming.connectCalendarButton")}
          </Button>
        </SidebarCard>
      )}

      {/* Connected, nothing scheduled */}
      {!isLoading &&
        isConnected &&
        events.length === 0 &&
        (needsSystemAudioGrant ? (
          <SidebarCard icon={Monitor} description={t("upcoming.systemAudioRequired")}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => systemAudio.request()}
              className="h-7 text-xs"
            >
              {systemAudio.mode === "native"
                ? t("upcoming.openSettings")
                : t("onboarding.permissions.grantAccess")}
            </Button>
          </SidebarCard>
        ) : (
          <SidebarCard
            icon={Calendar}
            title={t("upcoming.noUpcomingEvents")}
            description={t("upcoming.moreCalendarsHint")}
          >
            <button
              onClick={onConnectCalendar}
              className="cursor-pointer text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              {t("upcoming.connectHere")}
            </button>
          </SidebarCard>
        ))}

      {/* Day cards */}
      {!isLoading && isConnected && groupedEvents.length > 0 && (
        <div className="space-y-2.5">
          {groupedEvents.map((group) => (
            <DayCard key={group.key} group={group} isNowFn={isNowFn} />
          ))}
        </div>
      )}
    </div>
  );
}
