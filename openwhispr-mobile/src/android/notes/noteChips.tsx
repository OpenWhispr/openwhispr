import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, View } from 'react-native';
import { calendarRepository } from '@/data/calendarRepository';
import { notesRepository } from '@/data';
import type { CalendarParticipant, GoogleCalendarEvent } from '@/data/calendarTypes';
import type { Note } from '@/data/types';
import {
  buildCalendarMeetingContext,
  parseCalendarParticipants,
} from '@/lib/calendar/meetingContext';
import { noteTakenAt } from '@/lib/notes/noteMeta';
import { Sentry } from '@/lib/sentry';
import { safeHaptics } from '@/lib/utils';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { useNotesStore } from '@/store/useNotesStore';
import { showToast } from '../settings/kit';
import { EventSheet, PeopleSheet } from './chipSheets';
import { MOVE_UNDO_MS, MoveToFolderSheet } from './moveSheet';
import { AttendeeCircles, MetaChip } from './noteParts';
import {
  accountFor,
  eventPeople,
  findLinkedEvent,
  linkPeople,
  parseNoteEventRef,
  unlinkPeople,
  withPeople,
  withoutPerson,
} from './noteMeta';
import { notesT, useNotesT } from './strings';

const DAY = 24 * 60 * 60 * 1000;
/** N8: "Search finds the last 3 days and what's coming up" — the calendar sync's own window. */
const LOOKBACK_DAYS = 3;
const LOOKAHEAD_DAYS = 31;

/** Every stored event in the window (and the note's own day), from every connected calendar. */
function useCalendarEvents(noteDate: Date) {
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const load = useGoogleCalendarStore((state) => state.load);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);
  const connected = useMemo(
    () => accounts.filter((account) => account.status === 'connected'),
    [accounts],
  );
  const noteDay = new Date(noteDate.getFullYear(), noteDate.getMonth(), noteDate.getDate());
  const noteDayKey = noteDay.getTime();
  const events = useMemo(() => {
    if (connected.length === 0) return [];
    try {
      const now = Date.now();
      const from = Math.min(now - LOOKBACK_DAYS * DAY, noteDayKey);
      const to = Math.max(now + LOOKAHEAD_DAYS * DAY, noteDayKey + DAY);
      const seen = new Set<number>();
      return connected
        .flatMap((account) =>
          calendarRepository.getUpcomingEvents(
            account.id,
            new Date(from).toISOString(),
            new Date(to).toISOString(),
          ),
        )
        .filter((event) => {
          if (seen.has(event.id) || event.allDay || event.status === 'cancelled') return false;
          seen.add(event.id);
          return true;
        });
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'android-note-event' } });
      return [];
    }
  }, [connected, noteDayKey]);
  return { connected: connected.length > 0, accounts: connected, events };
}

/** People from your calendar events and your other notes, for Add people's suggestions. */
function knownPeople(events: GoogleCalendarEvent[], noteId: number): CalendarParticipant[] {
  const people: CalendarParticipant[] = [];
  for (const event of events) people.push(...eventPeople(event));
  try {
    for (const other of notesRepository.getAllNotes()) {
      if (other.id === noteId || !other.participants) continue;
      people.push(...(parseCalendarParticipants(other.participants) ?? []));
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { feature: 'android-note-people' } });
  }
  return people;
}

type ContextUpdate = { participants?: CalendarParticipant[]; calendarEventId?: string };

/**
 * The chips under a note's title (Figma N1, N1b) and the sheets behind them. The date is read-only;
 * folder, people and the calendar event are buttons. A note missing one shows a quiet "Add…" chip
 * instead, which is also where it's filled in; Link event shows only with a calendar connected.
 */
export function NoteChips({
  note,
  dateLabel,
  folderName,
  canMove,
  attendees,
  viewerInitials,
  moveVisible,
  onMoveVisibleChange,
  onSheetOpenChange,
}: {
  note: Note | null;
  dateLabel: string;
  folderName: string | null;
  /** False when the note's teamspace isn't known here: it has nowhere safe to go. */
  canMove: boolean;
  /** Everyone on the note, with `self` marked for the viewer. */
  attendees: CalendarParticipant[];
  /** Your initials when the note is yours ("You · Took these notes"). */
  viewerInitials: string | null;
  moveVisible: boolean;
  onMoveVisibleChange: (visible: boolean) => void;
  onSheetOpenChange?: (open: boolean) => void;
}) {
  const t = useNotesT();
  const loadNotes = useNotesStore((state) => state.loadNotes);
  const [peopleSheet, setPeopleSheet] = useState<null | 'list' | 'add'>(null);
  const [eventSheet, setEventSheet] = useState<null | 'event' | 'pick'>(null);
  const noteId = note?.id ?? null;
  useEffect(() => {
    setPeopleSheet(null);
    setEventSheet(null);
  }, [noteId]);
  useEffect(() => {
    onSheetOpenChange?.(peopleSheet != null || eventSheet != null);
  }, [peopleSheet, eventSheet, onSheetOpenChange]);

  const noteDate = useMemo(
    () => noteTakenAt(note?.createdAt, note?.cloudUpdatedAt ?? note?.updatedAt) ?? new Date(),
    [note?.createdAt, note?.cloudUpdatedAt, note?.updatedAt],
  );
  const { connected, accounts, events } = useCalendarEvents(noteDate);
  const ref = parseNoteEventRef(note?.calendarEventId);
  const linked = Boolean(note?.calendarEventId);
  const event = findLinkedEvent(ref, events);
  const stored = useMemo(
    () => parseCalendarParticipants(note?.participants ?? null) ?? [],
    [note?.participants],
  );
  const people = attendees.filter((person) => !person.self && !person.resource);
  const fromEvent = event
    ? (() => {
        const keys = new Set(eventPeople(event).map((person) => person.email));
        return people.filter((person) => person.email && keys.has(person.email)).length;
      })()
    : 0;
  const candidates = useMemo(
    () =>
      peopleSheet === 'add' || peopleSheet === 'list' ? knownPeople(events, noteId ?? -1) : [],
    [events, noteId, peopleSheet],
  );

  const saveCalendarContext = (id: number, update: ContextUpdate) => {
    notesRepository.updateNoteCalendarContext(id, {
      ...(update.participants ? { participants: JSON.stringify(update.participants) } : {}),
      ...(update.calendarEventId !== undefined ? { calendarEventId: update.calendarEventId } : {}),
    });
    loadNotes();
  };
  const restore = useCallback(
    (snapshot: { participants: string | null; calendarEventId: string | null }) => {
      if (noteId == null) return;
      notesRepository.updateNoteCalendarContext(noteId, snapshot);
      loadNotes();
    },
    [loadNotes, noteId],
  );
  const snapshot = () => ({
    participants: note?.participants ?? null,
    calendarEventId: note?.calendarEventId ?? null,
  });
  const undoToast = (message: string, previous: ReturnType<typeof snapshot>) =>
    showToast(
      message,
      'neutral',
      { label: notesT('undo'), onPress: () => restore(previous), onClose: () => undefined },
      { durationMs: MOVE_UNDO_MS },
    );

  const removePerson = (person: CalendarParticipant) => {
    if (noteId == null) return;
    const previous = snapshot();
    saveCalendarContext(noteId, { participants: withoutPerson(stored, person) });
    safeHaptics('light');
    undoToast(t('removedPerson', { name: person.displayName || person.email || '' }), previous);
  };
  const addPeople = (added: CalendarParticipant[]) => {
    if (noteId == null || added.length === 0) return;
    saveCalendarContext(noteId, { participants: withPeople(stored, added) });
    safeHaptics('success');
    showToast(
      t('addedPeople', {
        count: added.length,
        name: added[0].displayName || added[0].email || '',
      }),
    );
  };
  const pickEvent = (picked: GoogleCalendarEvent) => {
    setEventSheet(null);
    if (noteId == null || picked.id === event?.id) return;
    const previous = snapshot();
    const context = buildCalendarMeetingContext(picked, accountFor(picked, accounts));
    // Changing the event first takes off the people the old one brought.
    saveCalendarContext(noteId, {
      calendarEventId: context.calendarEventId,
      participants: linkPeople(unlinkPeople(stored, event), picked),
    });
    safeHaptics('success');
    undoToast(t('eventLinked', { title: picked.summary?.trim() || t('untitledEvent') }), previous);
  };
  const unlink = () => {
    setEventSheet(null);
    if (noteId == null) return;
    const previous = snapshot();
    // Stored as "" rather than NULL, as desktop does, so sync carries the unlink.
    saveCalendarContext(noteId, { calendarEventId: '', participants: unlinkPeople(stored, event) });
    safeHaptics('light');
    undoToast(t('eventUnlinked'), previous);
  };
  const open = (url: string) => {
    Linking.openURL(url).catch((error) => Sentry.captureException(error));
  };

  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <MetaChip icon="Calendar" label={dateLabel} />
        {note && canMove ? (
          folderName ? (
            <MetaChip
              testID="note-folder-chip"
              icon="Folder"
              label={folderName}
              onPress={() => onMoveVisibleChange(true)}
            />
          ) : (
            <MetaChip
              testID="note-add-folder"
              icon="Folder"
              label={t('addToFolder')}
              quiet
              onPress={() => onMoveVisibleChange(true)}
            />
          )
        ) : null}
        {people.length > 0 ? (
          <AttendeeCircles
            people={people.map((person) => ({ name: person.displayName, email: person.email }))}
            onPress={() => setPeopleSheet('list')}
          />
        ) : note ? (
          <MetaChip
            testID="note-add-people"
            icon="Users"
            label={t('addPeople')}
            quiet
            onPress={() => setPeopleSheet('add')}
          />
        ) : null}
        {linked ? (
          <MetaChip
            testID="note-event-chip"
            icon="CalendarDays"
            label={event?.summary?.trim() || t('calendarEvent')}
            onPress={() => setEventSheet('event')}
          />
        ) : note && connected ? (
          <MetaChip
            testID="note-link-event"
            icon="CalendarDays"
            label={t('linkEvent')}
            quiet
            onPress={() => setEventSheet('pick')}
          />
        ) : null}
      </View>
      {canMove ? (
        <MoveToFolderSheet
          visible={moveVisible}
          note={note}
          onClose={() => onMoveVisibleChange(false)}
        />
      ) : null}
      <PeopleSheet
        visible={peopleSheet != null}
        startAdding={peopleSheet === 'add'}
        onClose={() => setPeopleSheet(null)}
        people={people}
        viewer={viewerInitials ? { initials: viewerInitials } : null}
        eventTitle={event?.summary?.trim() || null}
        fromEventCount={fromEvent}
        candidates={candidates}
        onRemove={removePerson}
        onAdd={addPeople}
      />
      <EventSheet
        visible={eventSheet != null}
        startPicking={eventSheet === 'pick'}
        onClose={() => setEventSheet(null)}
        linked={linked}
        event={event}
        events={events}
        noteDate={noteDate}
        onJoin={open}
        onOpen={open}
        onPick={pickEvent}
        onUnlink={unlink}
      />
    </>
  );
}
