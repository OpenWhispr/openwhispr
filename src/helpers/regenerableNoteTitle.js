// Decide whether "Generate notes" may (re)generate a note's title.
//
// A title is "auto-assigned" — and therefore safe to replace — when it is still
// one of the placeholder defaults the app stamps on creation, or the unedited
// summary of the calendar event the note is linked to. A title the user typed
// themselves is preserved.
//
// Why this exists: meeting notes are created with the calendar event summary or
// a hardcoded "New note" placeholder (meetingDetectionEngine.js), while personal
// notes default to "Untitled Note". The old gate only matched
// `title === t("notes.list.untitledNote")`, so a meeting note titled "New note"
// or a calendar summary never had its name generated — the content updated, the
// name never did.
//
// `placeholders` are the localized labels for the current UI language; the
// builtin list covers the English literals the DB default and the detection
// engine use regardless of locale. Matching is case-insensitive and trimmed.
const BUILTIN_PLACEHOLDERS = ["untitled note", "untitled", "new note"];

export function isRegenerableNoteTitle(title, placeholders = [], calendarEventName = null) {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed === "") return true;

  const set = new Set(BUILTIN_PLACEHOLDERS);
  for (const p of placeholders) {
    if (typeof p === "string" && p.trim()) set.add(p.trim().toLowerCase());
  }
  if (set.has(trimmed.toLowerCase())) return true;

  // Unedited calendar-event name (compared as-is — it's a real, meaningful name).
  if (typeof calendarEventName === "string" && calendarEventName.trim() === trimmed) return true;

  return false;
}
