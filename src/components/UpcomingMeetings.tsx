import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, Loader2, LogIn, Monitor, Video } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";
import type { CalendarEvent } from "../types/calendar";
import { formatUpcomingDateGroup } from "../utils/dateFormatting";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettingsStore } from "../stores/settingsStore";

interface UpcomingMeetingsProps {
  events: CalendarEvent[];
  isLoading: boolean;
}

const getJoinUrl = (event: CalendarEvent): string | null => {
  if (event.hangout_link) return event.hangout_link;
  if (!event.conference_data) return null;
  try {
    const data = JSON.parse(event.conference_data);
    return (
      data?.entryPoints?.find(
        (ep: { entryPointType: string; uri?: string }) => ep.entryPointType === "video"
      )?.uri || null
    );
  } catch {
    return null;
  }
};

const openJoinUrl = (url: string) => {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
};

export default function UpcomingMeetings({ events, isLoading }: UpcomingMeetingsProps) {
  const { t, i18n } = useTranslation();
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const systemAudio = useSystemAudioPermission();
  const isSignedIn = useSettingsStore((s) => s.isSignedIn);

  const now = useMemo(() => new Date(), []);

  const groupedEvents = useMemo(() => {
    if (events.length === 0) return [];
    const groups: { label: string; items: CalendarEvent[] }[] = [];
    let currentLabel: string | null = null;

    for (const event of events) {
      const label = formatUpcomingDateGroup(event.start_time, t);
      if (label !== currentLabel) {
        groups.push({ label, items: [event] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(event);
      }
    }
    return groups;
  }, [events, t]);

  const formatTimeRange = (startTime: string, endTime: string): string => {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const locale = i18n.language;

    const startStr = start.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
    const endStr = end.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });

    return `${startStr} \u2013 ${endStr}`;
  };

  const isHappeningNow = (event: CalendarEvent): boolean => {
    const start = new Date(event.start_time);
    const end = new Date(event.end_time);
    return start <= now && now <= end;
  };

  return (
    <div className="w-64 sticky top-0 self-start max-h-screen overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-1.5 pb-2.5">
        <Calendar size={12} className="text-muted-foreground" />
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          {t("upcoming.title")}
        </span>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-6">
          <Loader2 size={14} className="animate-spin text-primary" />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && events.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 px-3">
          {systemAudio.isMacOS && systemAudio.status === "denied" ? (
            <>
              <Monitor size={24} className="text-muted-foreground/30 mb-2.5" />
              <p className="text-xs text-muted-foreground/60 text-center mb-3">
                {t("upcoming.systemAudioRequired")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={systemAudio.openSettings}
                className="text-xs h-7"
              >
                {t("upcoming.openSettings")}
              </Button>
            </>
          ) : !isSignedIn ? (
            <>
              <LogIn size={24} className="text-muted-foreground/30 mb-2.5" />
              <p className="text-xs font-medium text-muted-foreground/70 text-center mb-1">
                {t("upcoming.signInRequired")}
              </p>
              <p className="text-xs text-muted-foreground/50 text-center mb-3">
                {t("upcoming.signInDescription")}
              </p>
            </>
          ) : (
            <>
              <Calendar size={24} className="text-muted-foreground/30 mb-2.5" />
              <p className="text-xs text-muted-foreground/60 text-center">
                {t("upcoming.noMoreMeetings")}
              </p>
            </>
          )}
        </div>
      )}

      {/* Grouped event list */}
      {!isLoading && groupedEvents.length > 0 && (
        <div>
          {groupedEvents.map((group, groupIndex) => (
            <div key={group.label} className={groupIndex > 0 ? "mt-4" : ""}>
              <div className="pt-2 pb-2">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {group.label}
                </span>
              </div>
              <div className="space-y-1.5">
                {group.items.map((event) => {
                  const joinUrl = getJoinUrl(event);
                  const isNow = isHappeningNow(event);
                  const isHovered = hoveredEventId === event.id;

                  return (
                    <div
                      key={event.id}
                      className="group rounded-md border border-border/40 dark:border-border-subtle/60 bg-card/50 dark:bg-surface-2/60 px-3 py-2.5 transition-colors duration-150 hover:bg-muted/30 dark:hover:bg-surface-2/80"
                      onMouseEnter={() => setHoveredEventId(event.id)}
                      onMouseLeave={() => setHoveredEventId(null)}
                    >
                      <div className="flex items-start gap-2.5">
                        {/* Time / Now indicator */}
                        <div className="shrink-0 pt-0.5">
                          {isNow ? (
                            <div className="flex items-center gap-1.5">
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-green-500 opacity-75" />
                                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                              </span>
                              <span className="text-[11px] font-medium text-green-600 dark:text-green-400 tabular-nums">
                                {t("upcoming.now")}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {formatTimeRange(event.start_time, event.end_time)}
                            </span>
                          )}
                        </div>

                        {/* Spacer to push join button right */}
                        <div className="flex-1" />

                        {/* Join button (on hover) */}
                        {joinUrl && (
                          <div
                            className={cn(
                              "shrink-0 transition-opacity duration-150",
                              isHovered ? "opacity-100" : "opacity-0"
                            )}
                          >
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => openJoinUrl(joinUrl)}
                              title={t("upcoming.join")}
                              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
                            >
                              <Video size={12} />
                            </Button>
                          </div>
                        )}
                      </div>

                      {/* Title + attendees */}
                      <div className="mt-1 flex items-baseline gap-1.5">
                        <p className="flex-1 min-w-0 text-foreground text-sm leading-snug line-clamp-2">
                          {event.summary || t("upcoming.untitledEvent")}
                        </p>
                        {event.attendees_count > 1 && (
                          <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
                            +{event.attendees_count - 1}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
