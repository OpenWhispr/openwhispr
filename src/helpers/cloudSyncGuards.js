// Sync guards shared by SyncService and the node --test suite (#1290).

// SQLite `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" (no T, no millis, no Z);
// the cloud sends ISO 8601 "YYYY-MM-DDTHH:MM:SS.sssZ". Normalize both to
// millis-precision ISO so the pull loop's lexical greater-than compares
// correctly — without the ".000" pad a whole-second local value sorts after a
// sub-second cloud value at the same instant ('Z' > '.').
export function normalizeTimestamp(value) {
  if (!value) return "";
  const iso = value.replace(" ", "T").replace(/Z$/, "");
  return (/\.\d+$/.test(iso) ? iso : `${iso}.000`) + "Z";
}

// Last-writer-wins gate for the pull loops. A raw compare hands every
// same-UTC-day conflict to the cloud copy ('T' > ' ' at index 10), which is
// how a staler empty cloud shell overwrote fresh local notes (#1290).
export function isCloudEntryNewer(cloudUpdatedAt, localUpdatedAt) {
  return normalizeTimestamp(cloudUpdatedAt) > normalizeTimestamp(localUpdatedAt);
}

// Full-content payload for note pushes — a content-less PATCH still bumps
// the cloud row's updated_at, so the next pull elects a copy that never
// received the local edit (#1290). No client_note_id here: legacy cloud
// notes carry a different backfilled UUID per device, so PATCHing it on
// every push would fork duplicate notes; only the one-shot migration branch
// sends it. `cloudFolderId` is the note's folder already mapped to its cloud
// id (null when folderless or unmapped).
export function buildNoteUpdatePayload(note, cloudFolderId) {
  return {
    title: note.title,
    content: note.content,
    enhanced_content: note.enhanced_content,
    enhancement_prompt: note.enhancement_prompt,
    enhanced_at_content_hash: note.enhanced_at_content_hash,
    note_type: note.note_type,
    source_file: note.source_file,
    audio_duration_seconds: note.audio_duration_seconds,
    transcript: note.transcript,
    participants: note.participants,
    calendar_event_id: note.calendar_event_id,
    diarization_enabled: note.diarization_enabled,
    expected_speaker_count: note.expected_speaker_count,
    folder_id: cloudFolderId ?? null,
    updated_at: note.updated_at,
    // The server revision this device last acked; the server 409s when a newer
    // write landed since. Omitted for pre-guard rows (null base), which keeps
    // the legacy last-write-wins contract for them.
    ...(note.cloud_updated_at ? { base_updated_at: note.cloud_updated_at } : {}),
  };
}

// POST creates a new cloud identity and therefore has no prior server
// revision to compare. Forks from older databases can retain a stale base, so
// derive create payloads explicitly rather than forwarding base_updated_at.
export function buildNoteCreatePayload(note, cloudFolderId) {
  const payload = buildNoteUpdatePayload(note, cloudFolderId);
  delete payload.base_updated_at;
  return payload;
}
