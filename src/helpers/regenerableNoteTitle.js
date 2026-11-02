// A title may be (re)generated only while it is still a placeholder default
// (localized labels plus the English literals meetingDetectionEngine.js stamps
// regardless of locale) — never once it is a real name, whether the user typed
// it or it came from the calendar event the meeting was recorded for.
const BUILTIN_PLACEHOLDERS = ["untitled note", "untitled", "new note"];

export function isRegenerableNoteTitle(title, placeholders = []) {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed === "") return true;

  const set = new Set(BUILTIN_PLACEHOLDERS);
  for (const p of placeholders) {
    if (typeof p === "string" && p.trim()) set.add(p.trim().toLowerCase());
  }
  return set.has(trimmed.toLowerCase());
}
