import type { DateBucketKey } from './groupNotesByDate';
import { parseNoteTimestamp, tryParseNoteTimestamp } from './parseNoteTimestamp';

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
  language?: string,
  yesterdayLabel = 'Yesterday',
): string {
  const d = language ? tryParseNoteTimestamp(updatedAt) : parseNoteTimestamp(updatedAt);
  if (!d || isNaN(d.getTime())) return '';

  if (bucket === 'today') {
    return language
      ? d.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
      : formatClockTime(d);
  }
  if (bucket === 'yesterday') {
    return yesterdayLabel;
  }
  if (bucket === 'prev7') {
    return language ? d.toLocaleDateString(language, { weekday: 'long' }) : WEEKDAYS[d.getDay()];
  }
  return d.toLocaleDateString(language, {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  });
}
