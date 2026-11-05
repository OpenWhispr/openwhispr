import { formatNoteRowTime } from '../formatNoteRowTime';
import { groupNotesByDate } from '../groupNotesByDate';
import type { Note } from '@/data';

it('retains the default formatter API and ignores Android-only presentation arguments', () => {
  expect(formatNoteRowTime.length).toBe(2);
  expect(
    Reflect.apply(formatNoteRowTime, undefined, [new Date(2026, 10, 2), 'yesterday', 'ar', 'أمس']),
  ).toBe('Yesterday');
});

it('retains default bucket labels when Android-only presentation is supplied', () => {
  const now = new Date(2026, 10, 3, 12);
  const notes = [{ id: 7, updatedAt: now.toISOString() }] as Note[];
  const groups = Reflect.apply(groupNotesByDate, undefined, [
    notes,
    now,
    { language: 'ar', labels: { today: 'اليوم' } },
  ]);
  expect(groups).toEqual([{ key: 'today', label: 'Today', notes }]);
  expect(groups[0].notes[0]).toBe(notes[0]);
});
