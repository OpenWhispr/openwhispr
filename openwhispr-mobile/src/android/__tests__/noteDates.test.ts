import { groupNotesByDate } from '@/lib/groupNotesByDate';
import { formatNoteRowTime } from '@/lib/formatNoteRowTime';
import type { Note } from '@/data';

const now = new Date(2026, 9, 16, 12);
const note = (id: number, date: Date) => ({ id, updatedAt: date.toISOString() }) as Note;
const labels = { today: 'اليوم', yesterday: 'أمس', prev7: 'آخر 7 أيام', prev30: 'آخر 30 يومًا' };

it('localizes every bucket without changing membership, ordering, or the input', () => {
  const notes = [
    note(1, new Date(2026, 8, 1, 12)),
    note(2, new Date(2026, 9, 15, 12)),
    note(3, new Date(2026, 9, 16, 10)),
    note(4, new Date(2026, 9, 12, 12)),
    note(5, new Date(2026, 8, 30, 12)),
  ];
  const original = JSON.stringify(notes);
  const english = groupNotesByDate(notes, now);
  const arabic = groupNotesByDate(notes, now, { language: 'ar', labels });
  expect(arabic.map(({ key, notes: rows }) => [key, rows.map((n) => n.id)])).toEqual(
    english.map(({ key, notes: rows }) => [key, rows.map((n) => n.id)]),
  );
  expect(arabic.map((b) => b.label)).toEqual([
    ...Object.values(labels),
    new Date(2026, 8, 1).toLocaleDateString('ar', { month: 'long', year: 'numeric' }),
  ]);
  expect(english.map((b) => b.label)).toEqual([
    'Today',
    'Yesterday',
    'Previous 7 Days',
    'Previous 30 Days',
    'September 2026',
  ]);
  expect(JSON.stringify(notes)).toBe(original);
});

it('formats Android row times in the app locale and keeps the existing iOS defaults', () => {
  const date = new Date(2026, 9, 15, 14, 5);
  expect(formatNoteRowTime(date, 'today')).toBe('14:05');
  expect(formatNoteRowTime(date, 'yesterday')).toBe('Yesterday');
  expect(formatNoteRowTime(date, 'yesterday', 'ar', 'أمس')).toBe('أمس');
  expect(formatNoteRowTime(date, 'today', 'de')).toBe(
    date.toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' }),
  );
  expect(formatNoteRowTime(date, 'prev7', 'ar')).toBe(
    date.toLocaleDateString('ar', { weekday: 'long' }),
  );
  expect(formatNoteRowTime(date, 'prev30', 'ja')).toBe(
    date.toLocaleDateString('ja', { month: 'numeric', day: 'numeric', year: 'numeric' }),
  );
  expect(formatNoteRowTime('2026-10-15 14:05:00', 'today', 'ar')).toBe(
    formatNoteRowTime('2026-10-15T14:05:00Z', 'today', 'ar'),
  );
  expect(formatNoteRowTime('invalid', 'today', 'ar')).toBe('');
});
