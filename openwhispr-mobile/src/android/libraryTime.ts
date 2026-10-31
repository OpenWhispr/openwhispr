import { tryParseNoteTimestamp } from '@/lib/parseNoteTimestamp';

/** Use the app language, not the device default or English relative-time suffixes.
 * Hermes supports DateTimeFormat; RelativeTimeFormat is not available on every build.
 */
export function formatLibraryTime(timestamp: number | string, language: string): string {
  const date = tryParseNoteTimestamp(timestamp);
  if (!date || !Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
