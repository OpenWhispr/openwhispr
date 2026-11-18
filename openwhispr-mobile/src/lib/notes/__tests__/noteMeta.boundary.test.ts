import { attendeeName, formatAttendeeChipLabel, formatNoteMetaDate } from '../noteMeta';
import type { CalendarParticipant } from '@/data/calendarTypes';

it('retains the original default formatter arity', () => {
  expect(formatNoteMetaDate.length).toBe(2);
});

it('retains the original default invalid-Date result', () => {
  expect(formatNoteMetaDate(new Date(NaN), new Date(2026, 10, 3))).toBe('Invalid Date, NaN:NaN');
});

it('ignores Android date presentation in the default helper', () => {
  const date = new Date(2026, 10, 3, 9, 5);
  expect(formatNoteMetaDate(date, date, { language: 'ar', today: 'اليوم', yesterday: 'أمس' })).toBe(
    'Today 09:05',
  );
});

it('ignores Android attendee labels in the default helpers', () => {
  const viewer = {
    email: 'fixture@example.invalid',
    displayName: 'Literal name',
    self: true,
  } as CalendarParticipant;
  const labels = { you: 'أنت', guest: 'ضيف' };
  expect(attendeeName(viewer, labels)).toBe('You');
  expect(formatAttendeeChipLabel([viewer], labels)).toBe('You');
  expect(attendeeName({} as CalendarParticipant, labels)).toBe('Guest');
});
