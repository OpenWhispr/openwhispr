import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { create } from 'zustand';
import { calendarRepository } from '@/data/calendarRepository';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { parseCalendarParticipants } from '@/lib/calendar/meetingContext';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { Sentry } from '@/lib/sentry';

/** The Up next card shows from an hour before a meeting until it ends (Figma L5). */
export const UP_NEXT_LEAD_MS = 60 * 60 * 1000;

/** Event ids the user hid with × this run of the app. */
const useHiddenUpNext = create<{ ids: number[] }>(() => ({ ids: [] }));

export function hideUpNext(id: number) {
  useHiddenUpNext.setState((state) => ({ ids: [...state.ids, id] }));
}

function startOfTomorrow(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

/** Today's meetings that haven't ended, from every connected Google calendar. */
export function useTodayMeetings(): { events: GoogleCalendarEvent[]; now: number } {
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const load = useGoogleCalendarStore((state) => state.load);
  const [now, setNow] = useState(() => Date.now());
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      load().catch(() => undefined);
      const timer = setInterval(() => setNow(Date.now()), 60 * 1000);
      return () => clearInterval(timer);
    }, [load]),
  );
  const events = useMemo(() => {
    try {
      const from = new Date(now);
      const fromIso = from.toISOString();
      const toIso = startOfTomorrow(from).toISOString();
      return accounts
        .filter((account) => account.status === 'connected')
        .flatMap((account) => calendarRepository.getUpcomingEvents(account.id, fromIso, toIso))
        .filter(
          (event) => !event.allDay && event.status !== 'cancelled' && Date.parse(event.endAt) > now,
        )
        .sort((left, right) => left.startAt.localeCompare(right.startAt));
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'android-notes-up-next' } });
      return [];
    }
  }, [accounts, now]);
  return { events, now };
}

export function useUpNext() {
  const { events, now } = useTodayMeetings();
  const hidden = useHiddenUpNext((state) => state.ids);
  const next = events.find((event) => Date.parse(event.startAt) - now <= UP_NEXT_LEAD_MS);
  const visible = next && !hidden.includes(next.id) ? next : null;
  return { next: visible, events, now, nextAnyTime: events[0] ?? null };
}

export function eventIsNow(event: GoogleCalendarEvent, now: number): boolean {
  return Date.parse(event.startAt) <= now && Date.parse(event.endAt) > now;
}

export function minutesUntil(event: GoogleCalendarEvent, now: number): number {
  return Math.max(1, Math.round((Date.parse(event.startAt) - now) / 60000));
}

export function eventTimeRange(event: GoogleCalendarEvent): string {
  const format = (iso: string) =>
    new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${format(event.startAt)}–${format(event.endAt)}`;
}

/** "SK", "PS" from a meeting's guests, at most `limit`, and how many more there are. */
export function eventInitials(
  event: GoogleCalendarEvent,
  limit = 2,
): { initials: string[]; more: number } {
  const people = (parseCalendarParticipants(event.attendeesJson) ?? []).filter(
    (person) => !person.self && !person.resource,
  );
  const initials = people
    .slice(0, limit)
    .map((person) => initialsOf(person.displayName || person.email));
  return { initials, more: Math.max(0, people.length - limit) };
}

export function initialsOf(nameOrEmail: string | null | undefined): string {
  const text = (nameOrEmail ?? '')
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const second = words.length > 1 ? (words[words.length - 1][0] ?? '') : (words[0][1] ?? '');
  return (first + second).toUpperCase();
}

export function useStableNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
