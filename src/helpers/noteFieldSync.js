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

// Fields a cloud copy deliberately cleared (not merely blank).
/** @returns {Array<"content" | "enhanced_content">} */
export function clearedNoteFields(cloudNote) {
  return NOTE_TEXT_FIELDS.filter(
    (field) => cloudNote[`${field}_state`] === "clear" && !cloudNote[field]?.trim()
  );
}

// A push must wait for the pull to resolve these first: a rejected create until
// Keep/Refresh links it to the actual cloud row, and a clear on a note with
// neither a revision nor a timestamp base, since the server preserves a blank
// it cannot attribute to a client that saw the current row.
export function noteAwaitsCloudResolution(note) {
  return Boolean(
    note.cloud_create_rejected ||
    (note.cloud_id &&
      hasPendingNoteClear(note) &&
      !hasNoteRevision(note.cloud_revision) &&
      !note.cloud_updated_at)
  );
}
