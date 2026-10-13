export const NOTE_TEXT_FIELDS = ["content", "enhanced_content"];

// What a summary clear removes along with the text. The template stays: it is
// the note's choice, so "Generate AI Summary" reruns the same one.
export const SUMMARY_CLEARED_METADATA = ["enhancement_prompt", "enhanced_at_content_hash"];
// Everything that travels with the summary text.
export const SUMMARY_METADATA = [...SUMMARY_CLEARED_METADATA, "enhancement_template_id"];

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

// Column values that bring local text fields to the cloud's copy: its text, or
// a clear it recorded, with the summary metadata that travels with it. Only
// columns that differ are returned. A blank the cloud never marked as a clear
// is no evidence of deletion (an older API, or a released desktop's blank), so
// it keeps the local text, as a pull does.
/** @returns {Record<string, string | null>} */
export function cloudTextUpdates(local, cloudNote, fields) {
  const cleared = clearedNoteFields(cloudNote);
  const updates = {};
  for (const field of fields) {
    const text = cloudNote[field]?.trim() ? cloudNote[field] : null;
    if (!text && !cleared.includes(field)) continue;
    const next = { [field]: text ?? (field === "content" ? "" : null) };
    if (field === "enhanced_content") {
      for (const key of SUMMARY_METADATA) {
        if (!text && SUMMARY_CLEARED_METADATA.includes(key)) next[key] = null;
        else if (cloudNote[key] !== undefined) next[key] = cloudNote[key];
      }
    }
    for (const [key, value] of Object.entries(next)) {
      if ((local[key] ?? null) !== value) updates[key] = value;
    }
  }
  return updates;
}

// A clear on a cloud row this device holds no revision for. Without a
// revision the push is legacy-shaped, and the server stores a desktop's
// legacy blank as unknown intent rather than a clear, so other devices would
// keep the text. The pull supplies a revision first.
export function hasUnrevisionedNoteClear(note) {
  return Boolean(
    note.cloud_id && hasPendingNoteClear(note) && !hasNoteRevision(note.cloud_revision)
  );
}

// A push must wait for a pull to resolve these first: a rejected create until
// Keep/Refresh links it to the actual cloud row, and a clear without a
// revision while the server keeps revisions (the pull supplies one). Against
// an API without revisions such a clear pushes as it always has.
export function noteAwaitsCloudResolution(note, serverKeepsRevisions) {
  return Boolean(
    note.cloud_create_rejected ||
    note.cloud_create_pending ||
    (serverKeepsRevisions && hasUnrevisionedNoteClear(note))
  );
}
