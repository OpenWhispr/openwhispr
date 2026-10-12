const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("./harness/db");
const destination = require("../../src/helpers/meetingNotificationDestination");

test("eligible destinations preserve database order and exclude retracted/deleted/account rows", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("first-account");
  const first = db.createFolder("Calls").folder;
  const removed = db.createFolder("Removed").folder;
  db.db.prepare("UPDATE folders SET left_team=1 WHERE id=?").run(removed.id);
  const ctx = destination.listMeetingDestinations(db);
  assert.ok(ctx.folders.some((f) => f.id === first.id));
  assert.ok(!ctx.folders.some((f) => f.id === removed.id));
  assert.equal(ctx.defaultDestination.folderId, db.getMeetingsFolder().id);
  assert.equal(
    destination.resolveMeetingDestination(db, { folderId: first.id, spaceId: first.space_id + 99 }),
    null
  );
  assert.equal(
    destination.resolveMeetingDestination(db, { folderId: first.id, spaceId: first.space_id }).id,
    first.id
  );
  db.setActiveAccountId("another-account");
  assert.equal(
    destination.resolveMeetingDestination(db, { folderId: first.id, spaceId: first.space_id }),
    null
  );
});

test("five recent selections are deduplicated and pruned by exact space; default does not promote", () => {
  let history = [];
  for (let i = 1; i <= 7; i++)
    history = destination.rememberMeetingDestination(history, { folderId: i, spaceId: 1 });
  assert.deepEqual(
    history.map((r) => r.folderId),
    [7, 6, 5, 4, 3]
  );
  const next = destination.rememberMeetingDestination(history, { folderId: 5, spaceId: 1 });
  assert.deepEqual(
    next.map((r) => r.folderId),
    [5, 7, 6, 4, 3]
  );
  assert.deepEqual(
    history.map((r) => r.folderId),
    [7, 6, 5, 4, 3]
  );
  assert.deepEqual(
    destination.pruneMeetingDestinations(next, [
      { id: 5, space_id: 2 },
      { id: 7, space_id: 1 },
    ]),
    [{ folderId: 7, spaceId: 1 }]
  );
});

test("context failure is an error rather than an empty folder list", () => {
  assert.throws(
    () =>
      destination.listMeetingDestinations({
        getSpaces() {
          throw Error("offline db");
        },
      }),
    /offline db/
  );
});
