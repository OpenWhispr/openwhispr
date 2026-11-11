// A queued delete the cloud does not confirm (a 404, or a batch answer that
// leaves the row out) ends for the account's own row: its copy is already gone.
// An unattributed tombstone on a device another account has used may be that
// account's, whose cloud still holds the copy; dropping it there would let the
// owner's next pull bring the row back. It waits for its owner instead, and
// the account that could not deliver it stops sending it. Real DatabaseManager
// and SyncService on one window; only HTTP is faked, with one cloud per account.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");

const DELETE_ROUTES = [
  "/api/conversations/delete",
  "/api/transcriptions/batch-delete",
  "/api/dictionary/delete",
  "/api/snippets/delete",
];
const TABLES = ["agent_conversations", "transcriptions", "custom_dictionary", "snippets"];

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

function seedOneOfEach(cloud, tag) {
  const at = daysAgo(3);
  cloud.seedConversation({
    title: `${tag} chat`,
    client_conversation_id: `${tag}-chat`,
    created_at: at,
    updated_at: at,
    messages: [{ role: "user", content: "hello", created_at: at }],
  });
  cloud.seedTranscription({
    text: `${tag} dictation`,
    client_transcription_id: `${tag}-dictation`,
    created_at: at,
    updated_at: at,
  });
  cloud.seedDictionaryEntry({
    word: `${tag}Word`,
    client_dict_id: `${tag}-word`,
    created_at: at,
    updated_at: at,
  });
  cloud.seedSnippet({
    trigger: `${tag}trig`,
    replacement: "x",
    client_snippet_id: `${tag}-snippet`,
    created_at: at,
    updated_at: at,
  });
}

// What the user does to remove one of each kind from the lists in view.
function deleteEverythingInView(db) {
  for (const chat of db.getAgentConversations()) db.deleteAgentConversation(chat.id);
  for (const dictation of db.getTranscriptions()) db.deleteTranscription(dictation.id);
  db.applyDictionaryChanges({ remove: db.getDictionary() });
  db.setSnippets([]);
}

const queuedDeletes = (db) =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NOT NULL AND sync_status = 'pending'`
        )
        .get().n,
    ])
  );
const oneOfEach = Object.fromEntries(TABLES.map((table) => [table, 1]));
const noneLeft = Object.fromEntries(TABLES.map((table) => [table, 0]));

const deleteRequests = (cloud, from = 0) =>
  cloud.log
    .slice(from)
    .filter((call) => DELETE_ROUTES.includes(routeOf(call)))
    .map(routeOf)
    .sort();
const liveRows = (cloud) =>
  [cloud.conversations(), cloud.transcriptions(), cloud.dictionary(), cloud.snippets()]
    .flat()
    .filter((row) => !row.deleted_at).length;

test("another account's queued deletes survive this account's pass and reach their own cloud", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const { db } = device;
  const cloudA = createAccountCloud();
  const cloudB = createAccountCloud();
  seedOneOfEach(cloudB, "b");

  // Both accounts have signed in here, so signed out shows unattributed rows
  // alone. B's rows are as a build from before attribution left them, beside
  // one row of its own.
  await device.signIn("account-a", cloudA);
  device.signOut();
  await device.signIn("account-b", cloudB);
  await device.service.syncAll(true);
  for (const table of TABLES) {
    db.db.prepare(`UPDATE ${table} SET account_id = NULL, legacy_unattributed = 1`).run();
  }
  db.applyDictionaryChanges({ add: ["BravoOnly"] });
  await device.service.syncAll(true);
  device.signOut();
  // Removed while nobody was signed in, so nothing says whose deletes they are.
  deleteEverythingInView(db);
  assert.deepEqual(queuedDeletes(db), oneOfEach, "one unattributed tombstone of each kind");

  await device.signIn("account-a", cloudA);
  await device.service.syncAll(true);
  assert.deepEqual(deleteRequests(cloudA), DELETE_ROUTES.toSorted(), "A's cloud is asked once");
  assert.deepEqual(queuedDeletes(db), oneOfEach, "it holds none of them, so the tombstones stay");

  const secondPass = cloudA.log.length;
  await device.service.syncAll(true);
  assert.deepEqual(deleteRequests(cloudA, secondPass), [], "A does not send them again");
  assert.equal(liveRows(cloudB), 5, "B's cloud still holds every copy");

  device.signOut();
  await device.signIn("account-b", cloudB);
  await device.service.syncAll(true);
  assert.deepEqual(deleteRequests(cloudB), DELETE_ROUTES.toSorted(), "B's pass delivers them");
  assert.equal(liveRows(cloudB), 1, "only B's own word is left in its cloud");
  assert.deepEqual(queuedDeletes(db), noneLeft);
  await device.service.syncAll(true);
  assert.deepEqual(
    {
      chats: db.getAgentConversations(),
      dictations: db.getTranscriptions(),
      words: db.getDictionary(),
      snippets: db.getSnippets(),
    },
    { chats: [], dictations: [], words: ["BravoOnly"], snippets: [] },
    "and B's next pull brings nothing back"
  );
});

for (const sharedDevice of [false, true]) {
  const where = sharedDevice ? "a device another account has used" : "a device of its own";
  test(`an account's own delete the cloud already applied ends on ${where}`, async (t) => {
    const device = createSyncDevice(t);
    if (!device) return;
    const { db } = device;
    const cloudA = createAccountCloud();
    seedOneOfEach(cloudA, "a");
    if (sharedDevice) {
      await device.signIn("account-b", createAccountCloud());
      db.applyDictionaryChanges({ add: ["BravoOnly"] });
      device.signOut();
    }

    await device.signIn("account-a", cloudA);
    await device.service.syncAll(true);
    deleteEverythingInView(db);
    assert.deepEqual(queuedDeletes(db), oneOfEach);
    // Another device of A's deleted the same rows first.
    for (const row of cloudA.conversations()) cloudA.deleteConversation(row.id);
    for (const row of cloudA.transcriptions()) cloudA.deleteTranscription(row.id);
    for (const [route, rows] of [
      ["/api/dictionary/delete", cloudA.dictionary()],
      ["/api/snippets/delete", cloudA.snippets()],
    ]) {
      for (const row of rows) await cloudA.request({ method: "DELETE", path: route, body: row });
    }
    // The API answers a delete of a row already deleted with 404.
    cloudA.failWith("DELETE /api/dictionary/delete", { status: 404 });
    cloudA.failWith("DELETE /api/snippets/delete", { status: 404 });

    const firstPass = cloudA.log.length;
    await device.service.syncAll(true);
    assert.deepEqual(deleteRequests(cloudA, firstPass), DELETE_ROUTES.toSorted());
    assert.deepEqual(queuedDeletes(db), noneLeft, "nothing is left to retry");

    const secondPass = cloudA.log.length;
    await device.service.syncAll(true);
    assert.deepEqual(deleteRequests(cloudA, secondPass), []);
  });
}

test("an unattributed delete ends on a device no other account has used", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const { db } = device;
  const cloudA = createAccountCloud();
  seedOneOfEach(cloudA, "a");

  await device.signIn("account-a", cloudA);
  await device.service.syncAll(true);
  // Tombstones nothing attributes, whose copies the cloud no longer holds.
  deleteEverythingInView(db);
  for (const table of TABLES) {
    db.db.prepare(`UPDATE ${table} SET account_id = NULL, legacy_unattributed = 1`).run();
    db.db.prepare(`UPDATE ${table} SET cloud_id = 'gone-' || cloud_id`).run();
  }
  assert.deepEqual(queuedDeletes(db), oneOfEach);
  cloudA.failWith("DELETE /api/conversations/delete", { status: 404 });
  cloudA.failWith("DELETE /api/dictionary/delete", { status: 404 });
  cloudA.failWith("DELETE /api/snippets/delete", { status: 404 });

  await device.service.syncAll(true);
  assert.deepEqual(queuedDeletes(db), noneLeft, "its only possible owner's cloud has no copy");
});
