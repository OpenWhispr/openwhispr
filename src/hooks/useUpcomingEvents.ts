import { useState, useEffect, useCallback, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { CalendarEvent } from "../types/calendar";
import { hasOtherAttendees } from "../utils/calendarAttendees";

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
  const mcalAccounts = useSettingsStore((s) => s.mcalAccounts);
  const appleCalendarConnected = useSettingsStore((s) => s.appleCalendarConnected);
  const isConnected = gcalAccounts.length > 0 || mcalAccounts.length > 0 || appleCalendarConnected;

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // Only the first load shows as loading. A refresh after a sync keeps the current
  // events on screen, so the list doesn't flash (or unmount whatever the user is doing
  // in it) every time a calendar syncs.
  const hasLoadedRef = useRef(false);

  const fetchEvents = useCallback(async () => {
    if (!isConnected) {
      hasLoadedRef.current = false;
      setEvents([]);
      return;
    }
    if (!hasLoadedRef.current) setIsLoading(true);
    try {
      const windowMinutes = getLookaheadMinutes();
      const result = await window.electronAPI?.gcalGetUpcomingEvents?.(windowMinutes);
      if (result?.success && Array.isArray(result.events)) {
        setEvents(result.events.filter(hasOtherAttendees));
      } else {
        setEvents([]);
      }
    } catch {
      setEvents([]);
    } finally {
      hasLoadedRef.current = true;
      setIsLoading(false);
    }
  }, [isConnected]);

  // Fetch on mount and when connection status changes
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Re-fetch when any provider syncs events
  useEffect(() => {
    if (!isConnected) return;
    const unsubGcal = window.electronAPI?.onGcalEventsSynced?.(() => {
      fetchEvents();
    });
    const unsubMcal = window.electronAPI?.onMcalEventsSynced?.(() => {
      fetchEvents();
    });
    const unsubAcal = window.electronAPI?.onAcalEventsSynced?.(() => {
      fetchEvents();
    });
    return () => {
      unsubGcal?.();
      unsubMcal?.();
      unsubAcal?.();
    };
  }, [isConnected, fetchEvents]);

  return { events, isLoading, isConnected };
}
