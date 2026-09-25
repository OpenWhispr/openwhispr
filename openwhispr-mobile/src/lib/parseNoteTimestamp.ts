// A trailing Z or ±HH:MM / ±HHMM offset already pins the zone.
const TIMEZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Parses a note timestamp, or returns null when it is missing or unparsable. */
export function tryParseNoteTimestamp(
  updatedAt: string | number | Date | null | undefined,
): Date | null {
  if (updatedAt instanceof Date) return updatedAt;
  if (typeof updatedAt === 'number') return new Date(updatedAt);
  if (!updatedAt) return null;
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" with a space and no zone.
  // Hermes (iOS) rejects that format; convert space → T and mark it UTC.
  const iso = updatedAt.replace(' ', 'T');
  const date = new Date(TIMEZONE_DESIGNATOR.test(iso) ? iso : iso + 'Z');
  return isNaN(date.getTime()) ? null : date;
}

export function parseNoteTimestamp(updatedAt: string | number | Date | null | undefined): Date {
  return tryParseNoteTimestamp(updatedAt) ?? new Date();
}
