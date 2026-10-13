import type { Note } from '@/data';
import { parseNoteTimestamp } from './parseNoteTimestamp';

export type DateBucketKey = 'today' | 'yesterday' | 'prev7' | 'prev30' | string;

export type DateBucket = {
  key: DateBucketKey;
  label: string;
  notes: Note[];
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a: Date, b: Date): number {
  const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
  return Math.round(ms / 86_400_000);
}

export function groupNotesByDate(notes: Note[], now: Date = new Date()): DateBucket[] {
  const orderedKeys: DateBucketKey[] = [];
  const buckets = new Map<DateBucketKey, DateBucket>();

  const ensure = (key: DateBucketKey, label: string) => {
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, notes: [] });
      orderedKeys.push(key);
    }
    return buckets.get(key)!;
  };

  ensure('today', 'Today');
  ensure('yesterday', 'Yesterday');
  ensure('prev7', 'Previous 7 Days');
  ensure('prev30', 'Previous 30 Days');

  const sorted = [...notes].sort((a, b) => {
    const ta = parseNoteTimestamp(a.updatedAt).getTime();
    const tb = parseNoteTimestamp(b.updatedAt).getTime();
    return tb - ta;
  });

  for (const note of sorted) {
    const updated = parseNoteTimestamp(note.updatedAt);
    const dayDelta = daysBetween(now, updated);

    let bucket: DateBucket;
    if (dayDelta <= 0) {
      bucket = ensure('today', 'Today');
    } else if (dayDelta === 1) {
      bucket = ensure('yesterday', 'Yesterday');
    } else if (dayDelta <= 7) {
      bucket = ensure('prev7', 'Previous 7 Days');
    } else if (dayDelta <= 30) {
      bucket = ensure('prev30', 'Previous 30 Days');
    } else {
      const key = `${updated.getFullYear()}-${String(updated.getMonth() + 1).padStart(2, '0')}`;
      const label = `${MONTHS[updated.getMonth()]} ${updated.getFullYear()}`;
      bucket = ensure(key, label);
    }
    bucket.notes.push(note);
  }

  return orderedKeys.map((k) => buckets.get(k)!).filter((b) => b.notes.length > 0);
}
