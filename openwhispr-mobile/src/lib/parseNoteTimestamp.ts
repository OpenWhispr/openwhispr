// A trailing Z or ±HH:MM / ±HHMM offset already pins the zone.
const TIMEZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Parses a note timestamp, or returns null when it is missing or unparsable. */
export function tryParseNoteTimestamp(
  timestamp: string | number | Date | null | undefined,
): Date | null {
  if (timestamp instanceof Date) return timestamp;
  if (typeof timestamp === 'number') return new Date(timestamp);
  if (!timestamp) return null;
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" with a space and no zone.
  // Hermes (iOS) rejects that format; convert space → T and mark it UTC.
  const iso = timestamp.replace(' ', 'T');
  const date = new Date(TIMEZONE_DESIGNATOR.test(iso) ? iso : iso + 'Z');
  return isNaN(date.getTime()) ? null : date;
}

export function parseNoteTimestamp(timestamp: string | number | Date | null | undefined): Date {
  return tryParseNoteTimestamp(timestamp) ?? new Date();
}
