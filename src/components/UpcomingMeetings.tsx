import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, ExternalLink, Loader2, Mic, Monitor, Video } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import PersonAvatar from "./ui/PersonAvatar";
import { cn } from "./lib/utils";
import type { CalendarAttendee, CalendarEvent } from "../types/calendar";
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

function parseAttendees(event: CalendarEvent): CalendarAttendee[] {
  if (!event.attendees) return [];
  try {
    const parsed = JSON.parse(event.attendees);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatTimeRange(locale: string, startTime: string, endTime: string): string {
  const format = (value: string) =>
    new Date(value).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return `${format(startTime)} – ${format(endTime)}`;
}

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
  return groups;
}

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
          className="flex shrink-0 items-center -space-x-1.5 rounded-full pt-0.5 outline-none transition-opacity hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring/40"
        >
          {attendees.slice(0, 3).map((a) => (
            <PersonAvatar
              key={a.email}
              email={a.email}
              displayName={a.displayName}
              size={16}
              className="ring-1 ring-background"
            />
          ))}
          {attendees.length > 3 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.5 text-[9px] font-medium text-muted-foreground ring-1 ring-background">
              +{attendees.length - 3}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-border/50 px-3 py-2.5">
          <p className="text-xs font-medium leading-snug text-foreground">
            {event.summary || t("upcoming.untitledEvent")}
          </p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{timeRange}</p>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {attendees.map((a) => (
            <div key={a.email} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <PersonAvatar email={a.email} displayName={a.displayName} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-foreground/80">
                  {a.displayName || a.email.split("@")[0]}
                  {a.self && (
                    <span className="ml-1 text-foreground/30">{t("notes.participants.me")}</span>
                  )}
                </p>
                <p className="truncate text-[11px] text-foreground/35">{a.email}</p>
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
    <div
      className={cn(
        "group/event border-l-2 pl-2.5",
        isNow ? "border-green-500/60" : "border-primary/25"
      )}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-snug text-foreground line-clamp-2">
          {event.summary || t("upcoming.untitledEvent")}
        </p>
        {attendees.length > 1 ? (
          <AttendeePopover
            event={event}
            attendees={attendees}
            timeRange={timeRange}
            joinUrl={joinUrl}
          />
        ) : event.attendees_count > 1 ? (
          <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground/70">
            +{event.attendees_count - 1}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        {isNow ? (
          <span className="flex items-center gap-1.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
            </span>
            <span className="text-[11px] font-medium tabular-nums text-green-600 dark:text-green-400">
              {t("upcoming.now")}
            </span>
          </span>
        ) : (
          <span className="text-[11px] tabular-nums text-muted-foreground">{timeRange}</span>
        )}
        <Button
          size="sm"
          variant={isNow ? "default" : "ghost"}
          onClick={startNotes}
          className={cn(
            "h-6 min-w-0 gap-1 px-2 text-[11px] font-medium",
            !isNow &&
              "text-muted-foreground opacity-0 transition-opacity duration-150 hover:text-foreground focus-visible:opacity-100 group-hover/event:opacity-100"
          )}
        >
          {joinUrl ? (
            <Video size={11} className="shrink-0" />
          ) : (
            <Mic size={11} className="shrink-0" />
          )}
          <span className="truncate">
            {joinUrl ? t("upcoming.joinAndTakeNotes") : t("upcoming.takeNotes")}
          </span>
        </Button>
      </div>
    </div>
  );
}

function DayCard({ group, isNowFn }: { group: DayGroup; isNowFn: (e: CalendarEvent) => boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 px-3 py-2.5 dark:border-border-subtle/60 dark:bg-surface-2/60">
      <div className="flex items-center gap-2 pb-2">
        <span className="text-[22px] font-semibold leading-none tabular-nums text-foreground">
          {group.date.getDate()}
        </span>
        <div className="flex flex-col justify-center">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium leading-tight text-foreground">
            {group.date.toLocaleDateString(locale, { month: "long" })}
            {group.isToday && <span className="h-1 w-1 rounded-full bg-red-500" />}
          </span>
          <span className="text-[10px] leading-tight text-muted-foreground">
            {group.date.toLocaleDateString(locale, { weekday: "short" })}
          </span>
        </div>
      </div>
      {group.items.length === 0 ? (
        <div className="border-l-2 border-border/40 pl-2.5 text-xs text-muted-foreground/60">
          {t("upcoming.noEventsToday")}
        </div>
      ) : (
        <div className="space-y-2.5">
          {group.items.map((event) => (
            <EventRow key={event.id} event={event} isNow={isNowFn(event)} />
          ))}
        </div>
      )}
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
    <div className="flex flex-col items-center rounded-lg border border-border bg-card/50 px-4 py-6 text-center dark:bg-surface-2/60">
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
    <div className="w-64 sticky top-0 self-start max-h-screen overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-1.5 pb-2.5">
        <Calendar size={12} className="text-muted-foreground" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("upcoming.title")}
        </span>
      </div>

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
        <div className="space-y-2">
          {groupedEvents.map((group) => (
            <DayCard key={group.key} group={group} isNowFn={isNowFn} />
          ))}
        </div>
      )}
    </div>
  );
}
