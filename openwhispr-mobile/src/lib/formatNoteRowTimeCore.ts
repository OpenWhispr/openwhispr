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

type Timestamp = Parameters<typeof parseNoteTimestamp>[0];
type TimePresentation = {
  parse?: (value: Timestamp) => Date | null;
  clock?: (date: Date) => string;
  weekday?: (date: Date) => string;
  date?: (date: Date) => string;
  yesterday?: string;
};

export function createNoteRowTimeFormatter({
  parse = parseNoteTimestamp,
  clock = formatClockTime,
  weekday = (value) => WEEKDAYS[value.getDay()],
  date = (value) =>
    value.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' }),
  yesterday = 'Yesterday',
}: TimePresentation = {}) {
  return function formatNoteRowTime(updatedAt: Timestamp, bucket: DateBucketKey): string {
    const d = parse(updatedAt);
    if (!d || isNaN(d.getTime())) return '';

    if (bucket === 'today') return clock(d);
    if (bucket === 'yesterday') return yesterday;
    if (bucket === 'prev7') return weekday(d);
    return date(d);
  };
}
