import type { DateBucketKey } from '@/android/lib/groupNotesByDate';
import { tryParseNoteTimestamp } from '@/android/shared/lib/parseNoteTimestamp';
import { createNoteRowTimeFormatter } from '@/android/lib/formatNoteRowTimeCore';

export { formatClockTime } from '@/android/lib/formatNoteRowTimeCore';

export function formatNoteRowTime(
  updatedAt: string | number | Date | null | undefined,
  bucket: DateBucketKey,
  language?: string,
  yesterdayLabel = 'Yesterday',
): string {
  return createNoteRowTimeFormatter({
    parse: language ? tryParseNoteTimestamp : undefined,
    clock: language
      ? (date) => date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
      : undefined,
    weekday: language
      ? (date) => date.toLocaleDateString(language, { weekday: 'long' })
      : undefined,
    date: (date) =>
      date.toLocaleDateString(language, { month: 'numeric', day: 'numeric', year: 'numeric' }),
    yesterday: yesterdayLabel,
  })(updatedAt, bucket);
}
