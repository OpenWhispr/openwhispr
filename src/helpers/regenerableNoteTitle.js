// A title may be (re)generated only while it is still a placeholder default
// (localized labels plus the English literals meetingDetectionEngine.js stamps
// regardless of locale) or the unedited calendar event summary — never after
// the user typed their own.
const BUILTIN_PLACEHOLDERS = ["untitled note", "untitled", "new note"];

export function isRegenerableNoteTitle(title, placeholders = [], calendarEventName = null) {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed === "") return true;

  const set = new Set(BUILTIN_PLACEHOLDERS);
  for (const p of placeholders) {
    if (typeof p === "string" && p.trim()) set.add(p.trim().toLowerCase());
  }
  if (set.has(trimmed.toLowerCase())) return true;

  return typeof calendarEventName === "string" && calendarEventName.trim() === trimmed;
}
