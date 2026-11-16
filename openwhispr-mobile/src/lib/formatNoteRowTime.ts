import type { DateBucketKey } from './groupNotesByDate';
import { parseNoteTimestamp } from './parseNoteTimestamp';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "14:05", the clock time the notes list shows. */
export function formatClockTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatNoteRowTime(
  updatedAt: string | number | Date | null | undefined,
  bucket: DateBucketKey,
): string {
  const d = parseNoteTimestamp(updatedAt);
  if (isNaN(d.getTime())) return '';

  if (bucket === 'today') {
    return formatClockTime(d);
  }
  if (bucket === 'yesterday') {
    return 'Yesterday';
  }
  if (bucket === 'prev7') {
    return WEEKDAYS[d.getDay()];
  }
  return d.toLocaleDateString(undefined, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  });
}
