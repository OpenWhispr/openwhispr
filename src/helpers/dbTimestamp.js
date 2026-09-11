// SQLite's CURRENT_TIMESTAMP records UTC with no zone designator, and the
// ECMAScript parser reads that form as *local* time -- so a stored timestamp
// read back with `new Date` lands hours away from the instant it names. Every
// main-process reader of a `transcriptions` timestamp goes through here.
//
// The renderer has its own copy of this rule in normalizeDbDate
// (src/utils/dateFormatting.ts); the two must agree, or the same row shows one
// time in the history list and another in its saved audio's filename.

const EXPLICIT_TIME_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function hasExplicitTimeZone(value) {
  return typeof value === "string" && EXPLICIT_TIME_ZONE.test(value.trim());
}

/** Returns null for anything unreadable, so callers can fall back explicitly. */
function parseDbTimestamp(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // The stored separator is a space; ISO 8601 wants "T". Normalizing it here
  // keeps the parse spec-defined rather than relying on the implementation's
  // legacy date parser, which is free to reject the space-separated form.
  const isoish = trimmed.replace(" ", "T");
  const parsed = new Date(EXPLICIT_TIME_ZONE.test(isoish) ? isoish : `${isoish}Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

module.exports = { hasExplicitTimeZone, parseDbTimestamp };
