const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/cloudSyncGuards.js");

// Regression for #1290: local rows carry SQLite format ("2026-07-22 08:47:00")
// while cloud rows are ISO ("2026-07-22T08:18:27.790Z"), so a raw lexical `>`
// let any same-UTC-day cloud copy beat any local edit and wipe it on pull.

test("a 29-minute-older cloud copy is not judged newer than a local edit", async () => {
  const { isCloudEntryNewer } = await load();
  // Raw lexical compare (the old gate) elects the older cloud copy:
  assert.equal("2026-07-22T08:18:00.000Z" > "2026-07-22 08:47:00", true);
  // The normalized gate must not:
  assert.equal(isCloudEntryNewer("2026-07-22T08:18:00.000Z", "2026-07-22 08:47:00"), false);
});

test("a whole-day-staler cloud copy is not judged newer", async () => {
  const { isCloudEntryNewer } = await load();
  assert.equal(isCloudEntryNewer("2026-07-22T00:00:00.000Z", "2026-07-22 23:59:59"), false);
});

test("a previous-day cloud copy still loses (control)", async () => {
  const { isCloudEntryNewer } = await load();
  assert.equal(isCloudEntryNewer("2026-07-21T23:59:59.000Z", "2026-07-22 08:47:00"), false);
});

test("a genuinely newer cloud copy still wins (last-writer-wins intact)", async () => {
  const { isCloudEntryNewer } = await load();
  assert.equal(isCloudEntryNewer("2026-07-22T08:47:01.000Z", "2026-07-22 08:47:00"), true);
  assert.equal(isCloudEntryNewer("2026-07-23T00:00:00.000Z", "2026-07-22 23:59:59"), true);
});

test("the same instant across formats is a tie, not a cloud win", async () => {
  const { isCloudEntryNewer } = await load();
  assert.equal(isCloudEntryNewer("2026-07-22T08:47:00.000Z", "2026-07-22 08:47:00"), false);
});

test("sub-second cloud precision beats a whole-second local value at the same second", async () => {
  const { isCloudEntryNewer } = await load();
  assert.equal(isCloudEntryNewer("2026-07-22T08:47:00.500Z", "2026-07-22 08:47:00"), true);
});

test("a missing local timestamp always yields to the cloud value", async () => {
  const { isCloudEntryNewer } = await load();
  assert.equal(isCloudEntryNewer("2026-07-22T08:47:00.000Z", ""), true);
  assert.equal(isCloudEntryNewer("2026-07-22T08:47:00.000Z", null), true);
});

// Regression for #1290's wipe engine: pushPendingNotes' migration branch
// PATCHed only { client_note_id }, bumping the cloud row's updated_at without
// uploading the local edit — the same pass then pulled the empty row back down.

const localNote = {
  id: 7,
  client_note_id: "client-uuid-1",
  cloud_id: "cloud-1",
  title: "Vision, Values, and Product Priorities",
  content: "REAL MEETING NOTES",
  enhanced_content: "ENHANCED NOTES",
  enhancement_prompt: "prompt",
  enhanced_at_content_hash: "hash-1",
  note_type: "meeting",
  source_file: null,
  audio_duration_seconds: 3130,
  transcript: '[{"text":"hello"}]',
  participants: '[{"email":"a@b.c"}]',
  calendar_event_id: "cal-ev-1",
  diarization_enabled: 1,
  expected_speaker_count: 2,
  folder_id: 3,
  sync_status: "pending",
  created_at: "2026-07-21 19:31:00",
  updated_at: "2026-07-22 08:47:00",
};

test("the note update payload carries the full content, not just identifiers", async () => {
  const { buildNoteUpdatePayload } = await load();
  const payload = buildNoteUpdatePayload(localNote, "cloud-folder-3");

  // Only the one-shot migration branch may send client_note_id
  // (see buildNoteUpdatePayload):
  assert.equal("client_note_id" in payload, false);
  assert.equal(payload.title, "Vision, Values, and Product Priorities");
  assert.equal(payload.content, "REAL MEETING NOTES");
  assert.equal(payload.enhanced_content, "ENHANCED NOTES");
  assert.equal(payload.transcript, '[{"text":"hello"}]');
  assert.equal(payload.enhancement_prompt, "prompt");
  assert.equal(payload.enhanced_at_content_hash, "hash-1");
  assert.equal(payload.note_type, "meeting");
  assert.equal(payload.audio_duration_seconds, 3130);
  assert.equal(payload.participants, '[{"email":"a@b.c"}]');
  assert.equal(payload.calendar_event_id, "cal-ev-1");
  assert.equal(payload.diarization_enabled, 1);
  assert.equal(payload.expected_speaker_count, 2);
  assert.equal(payload.updated_at, "2026-07-22 08:47:00");
});

test("the note update payload carries the pre-mapped cloud folder id", async () => {
  const { buildNoteUpdatePayload } = await load();
  assert.equal(buildNoteUpdatePayload(localNote, "cloud-folder-3").folder_id, "cloud-folder-3");
  // Unmapped or folderless notes push an explicit null, never undefined.
  assert.equal(buildNoteUpdatePayload(localNote, null).folder_id, null);
  assert.equal(buildNoteUpdatePayload(localNote, undefined).folder_id, null);
});

// Optimistic-concurrency contract (G2): the PATCH echoes the server revision
// this device last acked, never the local SQLite updated_at, so the server can
// 409 a stale overwrite of a teammate's newer edit.

test("the note update payload echoes cloud_updated_at as base_updated_at verbatim", async () => {
  const { buildNoteUpdatePayload } = await load();
  const payload = buildNoteUpdatePayload(
    { ...localNote, cloud_updated_at: "2026-07-22T08:40:00.123Z" },
    "cloud-folder-3"
  );
  assert.equal(payload.base_updated_at, "2026-07-22T08:40:00.123Z");
  // The local timestamp still rides as updated_at, unchanged:
  assert.equal(payload.updated_at, "2026-07-22 08:47:00");
});

test("pre-guard rows omit base_updated_at entirely (legacy last-write-wins)", async () => {
  const { buildNoteUpdatePayload } = await load();
  assert.equal("base_updated_at" in buildNoteUpdatePayload(localNote, null), false);
  assert.equal(
    "base_updated_at" in buildNoteUpdatePayload({ ...localNote, cloud_updated_at: null }, null),
    false
  );
});

test("note create payloads never send a stale optimistic-concurrency base", async () => {
  const { buildNoteCreatePayload } = await load();
  const payload = buildNoteCreatePayload(
    { ...localNote, cloud_updated_at: "2026-07-22T08:40:00.123Z" },
    "cloud-folder-3"
  );
  assert.equal("base_updated_at" in payload, false);
  assert.equal(payload.content, localNote.content);
  assert.equal(payload.folder_id, "cloud-folder-3");
});
