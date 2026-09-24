import type { DateBucketKey } from './groupNotesByDate';
import { parseNoteTimestamp } from './parseNoteTimestamp';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatNoteRowTime(
  updatedAt: string | number | Date | null | undefined,
  bucket: DateBucketKey,
): string {
  const d = parseNoteTimestamp(updatedAt);
  if (isNaN(d.getTime())) return '';

  if (bucket === 'today') {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
