import {
  attendeeName,
  formatAttendeeChipLabel,
  formatNoteMetaDate,
  markViewer,
  noteTakenAt,
  sortAttendees,
} from '@/lib/notes/noteMeta';
import type { CalendarParticipant } from '@/data/calendarTypes';

const person = (overrides: Partial<CalendarParticipant> = {}): CalendarParticipant => ({
  email: null,
  displayName: null,
  responseStatus: 'accepted',
  optional: false,
  organizer: false,
  resource: false,
  self: false,
  ...overrides,
});

// SQLite stores created_at as a UTC "YYYY-MM-DD HH:MM:SS" string.
const toSqlite = (date: Date): string => date.toISOString().replace('T', ' ').slice(0, 19);

describe('formatNoteMetaDate', () => {
  const now = new Date(2026, 8, 27, 15, 0);

  it('labels a note created today with its time, as the notes list shows it', () => {
    expect(formatNoteMetaDate(toSqlite(new Date(2026, 8, 27, 9, 27)), now)).toBe('Today 09:27');
  });

  it('labels a note created yesterday', () => {
    expect(formatNoteMetaDate(toSqlite(new Date(2026, 8, 26, 14, 5)), now)).toBe('Yesterday 14:05');
  });

  it('shows month and day for an earlier date this year', () => {
    const label = formatNoteMetaDate(toSqlite(new Date(2026, 8, 21, 9, 27)), now);
    expect(label).toMatch(/^Sep 21, /);
    expect(label).not.toContain('2026');
  });

  it('adds the year for an earlier year', () => {
    expect(formatNoteMetaDate(toSqlite(new Date(2025, 8, 21, 9, 27)), now)).toContain('2025');
  });

  it('returns an empty label when the timestamp is missing or unparsable', () => {
    expect(formatNoteMetaDate(null, now)).toBe('');
    expect(formatNoteMetaDate('not a date', now)).toBe('');
  });
});

describe('noteTakenAt', () => {
  it('uses the creation time of a note made or pulled with it', () => {
    expect(noteTakenAt('2026-06-01 09:00:00', '2026-06-26T10:00:00.000Z')).toEqual(
      new Date('2026-06-01T09:00:00.000Z'),
    );
  });

  it('uses the last edit when the creation time is the later pull time', () => {
    expect(noteTakenAt('2026-09-27 08:00:00', '2026-06-26T10:00:00.000Z')).toEqual(
      new Date('2026-06-26T10:00:00.000Z'),
    );
  });

  it('uses whichever timestamp is readable', () => {
    expect(noteTakenAt(null, '2026-06-26T10:00:00.000Z')).toEqual(
      new Date('2026-06-26T10:00:00.000Z'),
    );
    expect(noteTakenAt('2026-06-01 09:00:00', null)).toEqual(new Date('2026-06-01T09:00:00.000Z'));
    expect(noteTakenAt(null, null)).toBeNull();
  });
});

describe('sortAttendees', () => {
  it('drops rooms and puts the organizer first', () => {
    const sam = person({ displayName: 'Sam Lee' });
    const room = person({ displayName: 'Board Room', resource: true });
    const ana = person({ displayName: 'Ana Ruiz', organizer: true });
    expect(sortAttendees([sam, room, ana])).toEqual([ana, sam]);
  });

  it('drops people who declined', () => {
    const sam = person({ displayName: 'Sam Lee' });
    const kim = person({ displayName: 'Kim Park', responseStatus: 'declined' });
    expect(sortAttendees([sam, kim])).toEqual([sam]);
    expect(formatAttendeeChipLabel([sam, kim])).toBe('Sam');
  });

  it('drops rooms known only by their address or name, and repeated people', () => {
    const sam = person({ displayName: 'Sam Lee', email: 'sam@x.com' });
    const roomByEmail = person({ email: 'c_123@resource.calendar.google.com' });
    const roomByName = person({ displayName: 'Huddle Room 2' });
    const samAgain = person({ displayName: 'Sam', email: 'sam@x.com' });
    expect(sortAttendees([sam, roomByEmail, roomByName, samAgain])).toEqual([sam]);
  });
});

describe('markViewer', () => {
  const creator = person({ displayName: 'Sam Lee', email: 'sam@x.com', self: true });
  const viewer = person({ displayName: 'Ana Ruiz', email: 'ana@x.com' });

  it('keeps the calendar’s own row as you on a note you created', () => {
    expect(
      markViewer([creator, viewer], { creatorIsViewer: true, viewerEmail: 'sam@x.com' }),
    ).toEqual([creator, viewer]);
  });

  it('marks you, not the creator, on a teammate’s note', () => {
    const marked = markViewer([creator, viewer], {
      creatorIsViewer: false,
      viewerEmail: 'Ana@X.com',
    });
    expect(marked.map((participant) => participant.self)).toEqual([false, true]);
    expect(formatAttendeeChipLabel(marked)).toBe('Sam +1');
    expect(attendeeName(marked[0])).toBe('Sam Lee');
  });

  it('marks nobody on a teammate’s note you weren’t invited to', () => {
    const marked = markViewer([creator, viewer], { creatorIsViewer: false, viewerEmail: null });
    expect(marked.some((participant) => participant.self)).toBe(false);
  });
});

describe('attendeeName', () => {
  it('prefers the display name, then the email, then Guest', () => {
    expect(attendeeName(person({ displayName: ' Sam Lee ', email: 'sam@x.com' }))).toBe('Sam Lee');
    expect(attendeeName(person({ email: 'sam@x.com' }))).toBe('sam@x.com');
    expect(attendeeName(person())).toBe('Guest');
  });

  it('calls your own row You', () => {
    expect(attendeeName(person({ displayName: 'Me Myself', self: true }))).toBe('You');
  });
});

describe('formatAttendeeChipLabel', () => {
  it('names the first attendee who is not you, by first name, with a count of the rest', () => {
    const label = formatAttendeeChipLabel([
      person({ displayName: 'Me', self: true }),
      person({ displayName: 'Sam Lee' }),
      person({ displayName: 'Ana Ruiz' }),
      person({ email: 'kim@x.com' }),
    ]);
    expect(label).toBe('Sam +3');
  });

  it('starts from the organizer', () => {
    expect(
      formatAttendeeChipLabel([
        person({ displayName: 'Sam Lee' }),
        person({ displayName: 'Ana Ruiz', organizer: true }),
      ]),
    ).toBe('Ana +1');
  });

  it('omits the count for a single attendee', () => {
    expect(formatAttendeeChipLabel([person({ displayName: 'Sam Lee' })])).toBe('Sam');
  });

  it('falls back to the email local part when there is no name', () => {
    expect(formatAttendeeChipLabel([person({ email: 'kim@x.com' })])).toBe('kim');
  });

  it('reads You when you are the only person', () => {
    expect(formatAttendeeChipLabel([person({ self: true, displayName: 'Me' })])).toBe('You');
  });

  it('returns null when there are no people, only rooms', () => {
    expect(formatAttendeeChipLabel([])).toBeNull();
    expect(formatAttendeeChipLabel([person({ displayName: 'Room', resource: true })])).toBeNull();
  });
});

describe('Android metadata presentation', () => {
  it('uses the selected language for clock/calendar labels without changing the instant', () => {
    const now = new Date(2026, 9, 16, 12);
    const earlier = new Date(2026, 9, 15, 9, 5);
    const presentation = { language: 'ar', today: 'اليوم', yesterday: 'أمس' };
    const before = earlier.getTime();
    const time = earlier.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    expect(formatNoteMetaDate(toSqlite(earlier), now, presentation)).toBe(`أمس ${time}`);
    expect(formatNoteMetaDate(now, now, presentation)).toBe(
      `اليوم ${now.toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })}`,
    );
    expect(earlier.getTime()).toBe(before);
    expect(formatNoteMetaDate(earlier, now)).toBe('Yesterday 09:05');
  });

  it('localizes older dates and omits an invalid Date value', () => {
    const now = new Date(2026, 9, 16, 12);
    const date = new Date(2025, 0, 3, 8, 7);
    const presentation = { language: 'de', today: 'Heute', yesterday: 'Gestern' };
    expect(formatNoteMetaDate(date, now, presentation)).toBe(
      `${date.toLocaleDateString('de', { month: 'short', day: 'numeric', year: 'numeric' })}, ${date.toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' })}`,
    );
    expect(formatNoteMetaDate(new Date(NaN), now, presentation)).toBe('');
  });
});

it('localizes anonymous attendee labels without changing supplied names or membership', () => {
  const labels = { you: 'أنت', guest: 'ضيف' };
  const attendees = [
    person({ self: true, email: 'viewer@example.com' }),
    person({ displayName: 'Sam Lee' }),
    person({}),
  ];
  expect(attendeeName(attendees[0], labels)).toBe('أنت');
  expect(attendeeName(attendees[1], labels)).toBe('Sam Lee');
  expect(attendeeName(attendees[2], labels)).toBe('ضيف');
  expect(formatAttendeeChipLabel(attendees, labels)).toBe('Sam +1');
  expect(formatAttendeeChipLabel([attendees[0]], labels)).toBe('أنت');
  expect(formatAttendeeChipLabel([attendees[2]], labels)).toBeNull();
  expect(attendees[0].self).toBe(true);
});
