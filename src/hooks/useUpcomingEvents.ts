import { useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { CalendarEvent } from "../types/calendar";

export interface UseUpcomingEventsReturn {
  events: CalendarEvent[];
  isLoading: boolean;
  isConnected: boolean;
}

const LOOKAHEAD_DAYS = 7;

function getLookaheadMinutes(): number {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + LOOKAHEAD_DAYS);
  end.setHours(0, 0, 0, 0);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 60000));
}

export function useUpcomingEvents(): UseUpcomingEventsReturn {
  const gcalAccounts = useSettingsStore((s) => s.gcalAccounts);
  const isConnected = gcalAccounts.length > 0;

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    if (!isConnected) {
      setEvents([]);
      return;
    }
    setIsLoading(true);
    try {
      const windowMinutes = getLookaheadMinutes();
      const result = await window.electronAPI?.gcalGetUpcomingEvents?.(windowMinutes);
      if (result?.success && Array.isArray(result.events)) {
        setEvents(result.events);
      } else {
        setEvents([]);
      }
    } catch {
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected]);

  // Fetch on mount and when connection status changes
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Re-fetch when events are synced from Google Calendar
  useEffect(() => {
    if (!isConnected) return;
    const unsub = window.electronAPI?.onGcalEventsSynced?.(() => {
      fetchEvents();
    });
    return () => unsub?.();
  }, [isConnected, fetchEvents]);

  return { events, isLoading, isConnected };
}
