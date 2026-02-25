import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, LogOut, RefreshCw, Loader2 } from "lucide-react";
import { SettingsRow } from "./ui/SettingsSection";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Toggle } from "./ui/toggle";
import { useSettingsStore } from "../stores/settingsStore";
import type { GoogleCalendar, CalendarEvent } from "../types/calendar";

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/30 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>;
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

function formatEventTime(startTime: string): string {
  const date = new Date(startTime);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const timeStr = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);

  if (date.toDateString() === now.toDateString()) {
    return `Today ${timeStr}`;
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return `Tomorrow ${timeStr}`;
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export default function CalendarSettings() {
  const { t } = useTranslation();
  const {
    gcalConnected,
    gcalEmail,
    setGcalConnected,
    setGcalEmail,
    meetingProcessDetection,
    meetingAudioDetection,
    setMeetingProcessDetection,
    setMeetingAudioDetection,
  } = useSettingsStore();
  const [calendars, setCalendars] = useState<GoogleCalendar[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<CalendarEvent[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const loadData = useCallback(async () => {
    if (!gcalConnected) return;
    try {
      const [calsResult, eventsResult] = await Promise.all([
        window.electronAPI?.gcalGetCalendars?.(),
        window.electronAPI?.gcalGetUpcomingEvents?.(60),
      ]);
      if (calsResult?.calendars) setCalendars(calsResult.calendars);
      if (eventsResult?.events) setUpcomingEvents(eventsResult.events);
    } catch {
      // non-fatal
    }
  }, [gcalConnected]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const unsubConnection = window.electronAPI?.onGcalConnectionChanged?.(
      (data: { connected: boolean; email: string | null }) => {
        setGcalConnected(data.connected);
        setGcalEmail(data.email ?? "");
        if (data.connected) loadData();
      }
    );
    const unsubSync = window.electronAPI?.onGcalEventsSynced?.(() => {
      loadData();
    });
    return () => {
      unsubConnection?.();
      unsubSync?.();
    };
  }, [loadData, setGcalConnected, setGcalEmail]);

  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const result = await window.electronAPI?.gcalStartOAuth?.();
      if (result?.success) {
        setGcalConnected(true);
        setGcalEmail(result.email ?? "");
      }
    } finally {
      setIsConnecting(false);
    }
  }, [setGcalConnected, setGcalEmail]);

  const handleDisconnect = useCallback(async () => {
    setIsDisconnecting(true);
    try {
      await window.electronAPI?.gcalDisconnect?.();
      setGcalConnected(false);
      setGcalEmail("");
      setCalendars([]);
      setUpcomingEvents([]);
    } finally {
      setIsDisconnecting(false);
    }
  }, [setGcalConnected, setGcalEmail]);

  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      await window.electronAPI?.gcalSyncEvents?.();
      await loadData();
    } finally {
      setIsSyncing(false);
    }
  }, [loadData]);

  const handleToggleCalendar = useCallback(async (calendarId: string, isSelected: boolean) => {
    setCalendars((prev) =>
      prev.map((c) => (c.id === calendarId ? { ...c, is_selected: isSelected ? 1 : 0 } : c))
    );
    try {
      await window.electronAPI?.gcalSetCalendarSelection?.(calendarId, isSelected);
    } catch {
      setCalendars((prev) =>
        prev.map((c) => (c.id === calendarId ? { ...c, is_selected: isSelected ? 0 : 1 } : c))
      );
    }
  }, []);

  if (!gcalConnected) {
    return (
      <div className="space-y-5">
        <SectionHeader title={t("calendar.title")} />

        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("calendar.status")}
              description={t("calendar.notConnectedDescription")}
            >
              <Badge variant="outline">{t("calendar.disconnected")}</Badge>
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>

        <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/3 dark:bg-primary/6 p-4">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0 mt-0.5">
              <Calendar className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1 space-y-2.5">
              <div>
                <p className="text-xs font-medium text-foreground">
                  {t("calendar.connectCta.title")}
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                  {t("calendar.connectCta.description")}
                </p>
              </div>
              <Button onClick={handleConnect} disabled={isConnecting} size="sm" className="w-full">
                {isConnecting ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t("calendar.connecting")}
                  </>
                ) : (
                  <>
                    <Calendar className="mr-1.5 h-3.5 w-3.5" />
                    {t("calendar.connect")}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SectionHeader title={t("calendar.title")} />

      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0">
              <Calendar className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground truncate">{gcalEmail}</p>
            </div>
            <Badge variant="success">{t("calendar.connected")}</Badge>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      <SettingsPanel>
        <SettingsPanelRow>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleSync} disabled={isSyncing}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
              {isSyncing ? t("calendar.syncing") : t("calendar.sync")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
            >
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              {isDisconnecting ? t("calendar.disconnecting") : t("calendar.disconnect")}
            </Button>
          </div>
        </SettingsPanelRow>
      </SettingsPanel>

      {calendars.length > 0 && (
        <div>
          <SectionHeader title={t("calendar.calendarsTitle")} />
          <SettingsPanel>
            {calendars.map((cal) => (
              <SettingsPanelRow key={cal.id}>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {cal.background_color && (
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: cal.background_color }}
                      />
                    )}
                    <span className="text-xs font-medium text-foreground truncate">
                      {cal.summary}
                    </span>
                  </div>
                  <Toggle
                    checked={cal.is_selected === 1}
                    onChange={(checked) => handleToggleCalendar(cal.id, checked)}
                  />
                </div>
              </SettingsPanelRow>
            ))}
          </SettingsPanel>
        </div>
      )}

      {upcomingEvents.length > 0 && (
        <div>
          <SectionHeader title={t("calendar.upcomingTitle")} />
          <SettingsPanel>
            {upcomingEvents.slice(0, 3).map((event) => (
              <SettingsPanelRow key={event.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground truncate min-w-0 flex-1">
                    {event.summary || "—"}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {formatEventTime(event.start_time)}
                  </span>
                </div>
              </SettingsPanelRow>
            ))}
          </SettingsPanel>
        </div>
      )}

      <div>
        <SectionHeader
          title={t("calendar.detection.title")}
          description={t("calendar.detection.description")}
        />
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("calendar.detection.processDetection")}
              description={t("calendar.detection.processDescription")}
            >
              <Toggle
                checked={meetingProcessDetection}
                onChange={(checked) => {
                  setMeetingProcessDetection(checked);
                  window.electronAPI?.meetingDetectionSetPreferences?.({
                    processDetection: checked,
                  });
                }}
              />
            </SettingsRow>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <SettingsRow
              label={t("calendar.detection.audioDetection")}
              description={t("calendar.detection.audioDescription")}
            >
              <Toggle
                checked={meetingAudioDetection}
                onChange={(checked) => {
                  setMeetingAudioDetection(checked);
                  window.electronAPI?.meetingDetectionSetPreferences?.({
                    audioDetection: checked,
                  });
                }}
              />
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}
