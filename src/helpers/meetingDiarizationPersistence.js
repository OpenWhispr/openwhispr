const {
  mergeTranscriptSegments,
  serializeTranscriptSegments,
} = require("./transcriptSpeakerStateCore");

function snapshotMeetingNoteIdentity(databaseManager, noteId) {
  if (!Number.isInteger(noteId) || noteId <= 0) return null;

  const note = databaseManager.getNote(noteId);
  if (!note || note.deleted_at || !note.client_note_id) return null;

  return Object.freeze({ noteId: note.id, clientNoteId: note.client_note_id });
}

function matchesMeetingNoteIdentity(databaseManager, identity) {
  if (!identity?.noteId || !identity.clientNoteId) return false;
  const note = databaseManager.getNote(identity.noteId);
  return !!note && !note.deleted_at && note.client_note_id === identity.clientNoteId;
}

function resolveMeetingNoteIdentity(databaseManager, noteId, expectedClientNoteId) {
  if (noteId == null && expectedClientNoteId == null) return null;
  if (!Number.isInteger(noteId) || !expectedClientNoteId) return null;

  const identity = snapshotMeetingNoteIdentity(databaseManager, noteId);
  return identity?.clientNoteId === expectedClientNoteId ? identity : null;
}

function parseStoredTranscript(raw) {
  if (typeof raw !== "string" || !raw.startsWith("[")) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((segment, index) => ({ ...segment, id: `stored-${index}` }));
  } catch {
    return [];
  }
}

function embeddingBuffers(speakerEmbeddings) {
  const buffers = {};
  for (const [speakerId, values] of Object.entries(speakerEmbeddings || {})) {
    buffers[speakerId] = Buffer.from(new Float32Array(values).buffer);
  }
  return buffers;
}

function persistMeetingDiarizationResult({
  databaseManager,
  identity,
  segments,
  speakerEmbeddings = null,
  onNoteUpdated,
  onSpeakerEmbeddingsSaved,
}) {
  if (!identity?.noteId || !identity.clientNoteId) {
    return { status: "skipped", reason: "missing-identity" };
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return { status: "skipped", reason: "empty-segments" };
  }

  const current = databaseManager.getNote(identity.noteId);
  if (!current) return { status: "skipped", reason: "missing-note" };
  if (current.deleted_at) return { status: "skipped", reason: "deleted-note" };
  if (current.client_note_id !== identity.clientNoteId) {
    return { status: "skipped", reason: "identity-changed" };
  }

  const existing = parseStoredTranscript(current.transcript);
  const incoming = segments.map((segment, index) => ({
    ...segment,
    id: segment.id || `diarized-${index}`,
  }));
  const mergedSegments = mergeTranscriptSegments(existing, incoming);
  const update = databaseManager.updateNote(identity.noteId, {
    transcript: serializeTranscriptSegments(mergedSegments),
  });
  if (!update?.success || !update.note) {
    return { status: "skipped", reason: "update-failed" };
  }

  let embeddingsSaved = false;
  let embeddingError = null;
  if (speakerEmbeddings && Object.keys(speakerEmbeddings).length > 0) {
    try {
      databaseManager.saveNoteSpeakerEmbeddings(
        identity.noteId,
        embeddingBuffers(speakerEmbeddings)
      );
      embeddingsSaved = true;
    } catch (error) {
      embeddingError = error;
    }
  }

  onNoteUpdated?.(update.note);
  if (embeddingsSaved) onSpeakerEmbeddingsSaved?.({ ...identity });

  return {
    status: "persisted",
    note: update.note,
    segments: mergedSegments,
    embeddingsSaved,
    embeddingError,
  };
}

module.exports = {
  mergeTranscriptSegments,
  matchesMeetingNoteIdentity,
  parseStoredTranscript,
  persistMeetingDiarizationResult,
  resolveMeetingNoteIdentity,
  serializeTranscript: serializeTranscriptSegments,
  snapshotMeetingNoteIdentity,
};
