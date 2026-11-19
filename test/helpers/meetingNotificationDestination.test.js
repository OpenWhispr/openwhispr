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

test("meeting destinations show only the active workspace's Private and the teamspaces in scope", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("account-1");
  // B is active; A is the default. Each has a Private and a teamspace; one teamspace is legacy.
  db.setActiveWorkspaceScope({ activeWorkspaceId: "b", defaultWorkspaceId: "a" });
  const privateA = db.getPrivateSpaceId("a");
  const privateB = db.getPrivateSpaceId("b");
  const teamA = db.upsertSpaceFromCloud({ id: "team-a", name: "Alpha", workspace_id: "a" });
  const teamB = db.upsertSpaceFromCloud({ id: "team-b", name: "Beta", workspace_id: "b" });
  const legacy = db.upsertSpaceFromCloud({ id: "team-legacy", name: "Legacy" });
  const inA = db.createFolder("A plans", privateA).folder;
  const inB = db.createFolder("B plans", privateB).folder;
  const inTeamA = db.createFolder("Alpha docs", teamA.id).folder;
  const inTeamB = db.createFolder("Beta docs", teamB.id).folder;

  const ctx = destination.listMeetingDestinations(db);
  const listed = new Set([privateB, teamB.id, legacy.id]);
  assert.deepEqual(new Set(ctx.spaces.map((space) => space.id)), listed);
  assert.ok(ctx.folders.every((folder) => listed.has(folder.space_id)));
  assert.ok(ctx.folders.some((folder) => folder.id === inB.id));
  assert.ok(ctx.folders.some((folder) => folder.id === inTeamB.id));
  assert.ok(!ctx.folders.some((folder) => folder.id === inA.id || folder.id === inTeamA.id));
  // New folders and meetings default to the active workspace's Private.
  assert.equal(ctx.privateSpaceId, privateB);
  assert.equal(ctx.defaultDestination.spaceId, privateB);

  // The default workspace's own Private once it's the active one.
  db.setActiveWorkspaceScope({ activeWorkspaceId: "a", defaultWorkspaceId: "a" });
  const inDefault = destination.listMeetingDestinations(db);
  assert.deepEqual(
    new Set(inDefault.spaces.map((space) => space.id)),
    new Set([privateA, teamA.id, legacy.id])
  );
  assert.equal(inDefault.privateSpaceId, privateA);
});
