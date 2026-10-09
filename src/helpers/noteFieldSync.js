export const NOTE_TEXT_FIELDS = ["content", "enhanced_content"];

export function hasNoteRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function hasPendingNoteClear(note) {
  return NOTE_TEXT_FIELDS.some((field) => note[`${field}_sync_operation`] === "clear");
}

// Only local edit intent is sent. A pulled snapshot must never become a set
// operation merely because another field (for example the title) was edited.
export function noteFieldUpdates(note) {
  return Object.fromEntries(
    NOTE_TEXT_FIELDS.flatMap((field) => {
      const operation = note[`${field}_sync_operation`];
      return operation === "set" || operation === "clear" ? [[field, operation]] : [];
    })
  );
}
