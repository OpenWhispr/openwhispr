import { useEffect, useMemo, useState } from 'react';
import { calendarRepository } from '@/data/calendarRepository';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { buildCalendarMeetingContext } from '@/lib/calendar/meetingContext';
import { getMeetingCalendarEventSuggestions } from '@/lib/calendar/meetingSuggestions';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { Sentry } from '@/lib/sentry';

export function useMeetingCalendar(phase: string) {
  const [calendarEvents, setCalendarEvents] = useState<GoogleCalendarEvent[]>([]);
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<number | null>(null);
  const googleCalendarAccounts = useGoogleCalendarStore((s) => s.accounts);
  const loadGoogleCalendars = useGoogleCalendarStore((s) => s.load);
  const accountsById = useMemo(
    () => new Map(googleCalendarAccounts.map((account) => [account.id, account])),
    [googleCalendarAccounts],
  );
  const selectedCalendarEvent = useMemo(
    () => calendarEvents.find((event) => event.id === selectedCalendarEventId) ?? null,
    [calendarEvents, selectedCalendarEventId],
  );
  const selectedMeetingContext = useMemo(() => {
    if (!selectedCalendarEvent) return null;
    try {
      return buildCalendarMeetingContext(
        selectedCalendarEvent,
        accountsById.get(selectedCalendarEvent.accountId),
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: { feature: 'meeting-calendar-context', calendar_context_operation: 'build' },
      });
      return null;
    }
  }, [accountsById, selectedCalendarEvent]);

  useEffect(() => {
    if (phase !== 'prompt') return;
    loadGoogleCalendars().catch((error) => {
      Sentry.captureException(error, { tags: { feature: 'meeting-calendar-suggestions' } });
    });
  }, [loadGoogleCalendars, phase]);

  useEffect(() => {
    if (phase !== 'prompt') return;
    try {
      const events = getMeetingCalendarEventSuggestions(googleCalendarAccounts, calendarRepository);
      setCalendarEvents(events);
      setSelectedCalendarEventId((current) =>
        current != null && !events.some((event) => event.id === current) ? null : current,
      );
    } catch (error) {
      setCalendarEvents([]);
      setSelectedCalendarEventId(null);
      Sentry.captureException(error, { tags: { feature: 'meeting-calendar-suggestions' } });
    }
  }, [googleCalendarAccounts, phase]);

  return {
    calendarEvents,
    selectedCalendarEventId,
    setSelectedCalendarEventId,
    accountsById,
    selectedMeetingContext,
  };
}
