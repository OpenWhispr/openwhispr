const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db");
function input(db) {
  const folder = db.getFolders().find((f) => f.id === db.getMeetingsFolder().id);
  return {
    title: "Test meeting",
    folderId: folder.id,
    spaceId: folder.space_id,
    eventId: "event",
    participants: "[]",
  };
}
test("notification note creation atomically links metadata and reuses the owned calendar note", (t) => {
  const db = createDb(t);
  if (!db) return;
  const request = input(db);
  const first = db.createMeetingNoteForNotification(request);
  const second = db.createMeetingNoteForNotification(request);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.note.id, second.note.id);
  assert.equal(first.note.calendar_event_id, "event");
  assert.equal(db.getNotes().length, 1);
});
test("failed calendar metadata rolls the new note back, so retry creates just one note", (t) => {
  const db = createDb(t);
  if (!db) return;
  const original = db.updateNote;
  db.updateNote = () => ({ success: false });
  assert.throws(() => db.createMeetingNoteForNotification(input(db)), /metadata/i);
  assert.equal(db.getNotes().length, 0);
  db.updateNote = original;
  assert.equal(db.createMeetingNoteForNotification(input(db)).created, true);
  assert.equal(db.getNotes().length, 1);
});
test("strict calendar lookup throws but legacy lookup retains its null fallback", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db.exec("DROP TABLE notes");
  assert.equal(db.getOwnNoteByCalendarEventId("event"), null);
  assert.throws(() => db.getOwnNoteByCalendarEventId("event", { throwOnError: true }));
});
test("another account owned note is never reused by a notification", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("a");
  const first = db.createMeetingNoteForNotification(input(db));
  db.setActiveAccountId("b");
  const second = db.createMeetingNoteForNotification(input(db));
  assert.equal(second.created, true);
  assert.notEqual(first.note.id, second.note.id);
});
