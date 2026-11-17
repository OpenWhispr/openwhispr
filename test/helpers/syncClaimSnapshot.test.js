// The one-time claim after an upgrade: the first account to sync snapshots each
// table once to claim what its cloud holds. A table's snapshot counts when it
// completes, so a retry repeats only the tables still outstanding, and a table
// that fails every time waits longer between attempts instead of walking the
// cloud again on every pass. Real DatabaseManager and SyncService; only HTTP is
// faked.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");
const { localStorage: localStorageStub } = require("./harness/browserGlobals.js");

const MARKER = "syncCursors.unownedClaimedBy";
const TABLES = ["conversations", "transcriptions", "dictionary", "snippets"];
const LOCAL_TABLES = {
  conversations: "agent_conversations",
  transcriptions: "transcriptions",
  dictionary: "custom_dictionary",
  snippets: "snippets",
};

// A single-account device as an older build left it: every row synced, none
// attributed, and cursors past all of them with no owner recorded.
function seedUpgradedDevice(db, cloud, counts) {
  const start = Date.now() - 30 * 86400000;
  const at = (index) => new Date(start + index * 1000).toISOString();
  const insert = {
    conversations: db.db.prepare(
      "INSERT INTO agent_conversations (title, client_conversation_id, cloud_id, sync_status, created_at, updated_at, legacy_unattributed) VALUES (?, ?, ?, 'synced', ?, ?, 1)"
    ),
    transcriptions: db.db.prepare(
      "INSERT INTO transcriptions (text, client_transcription_id, cloud_id, sync_status, created_at, timestamp, legacy_unattributed) VALUES (?, ?, ?, 'synced', ?, ?, 1)"
    ),
    dictionary: db.db.prepare(
      "INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, created_at, updated_at, legacy_unattributed) VALUES (?, ?, ?, 'synced', ?, ?, 1)"
    ),
    snippets: db.db.prepare(
      "INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, created_at, updated_at, legacy_unattributed) VALUES (?, 'x', ?, ?, 'synced', ?, ?, 1)"
    ),
  };
  const seed = {
    conversations: (name, id, when) =>
      cloud.seedConversation({
        title: name,
        client_conversation_id: id,
        created_at: when,
        updated_at: when,
      }),
    transcriptions: (name, id, when) =>
      cloud.seedTranscription({
        text: name,
        client_transcription_id: id,
        created_at: when,
        updated_at: when,
      }),
    dictionary: (name, id, when) =>
      cloud.seedDictionaryEntry({
        word: name,
        client_dict_id: id,
        created_at: when,
        updated_at: when,
      }),
    snippets: (name, id, when) =>
      cloud.seedSnippet({
        trigger: name,
        replacement: "x",
        client_snippet_id: id,
        created_at: when,
        updated_at: when,
      }),
  };
  db.setActiveAccountId(null);
  db.db.transaction(() => {
    for (const table of TABLES) {
      for (let index = 0; index < counts[table]; index++) {
        const name = `${table}${index}`;
        const row = seed[table](name, `${table}-${index}`, at(index));
        insert[table].run(name, `${table}-${index}`, row.id, at(index), at(index));
      }
    }
  })();
  const cursor = new Date().toISOString();
  for (const table of TABLES) localStorageStub.setItem(`lastSyncedAt.${table}`, cursor);
  localStorageStub.setItem("dictionarySharedAtBackfill", "true");
}

const unclaimed = (db) =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      db.db
        .prepare(`SELECT COUNT(*) AS n FROM ${LOCAL_TABLES[table]} WHERE account_id IS NULL`)
        .get().n,
    ])
  );

// A delta carries the cursor as `since`; a snapshot carries none, or the epoch
// for the dictionary.
const isSnapshot = (call) =>
  call.method === "GET" &&
  /^\/api\/(conversations|transcriptions|dictionary|snippets)\/list$/.test(routeOf(call)) &&
  (!call.path.includes("since=") || call.path.includes("since=1970"));
const snapshotOf = (table) => (call) => isSnapshot(call) && routeOf(call) === `/api/${table}/list`;
const snapshotsAsked = (cloud, from) => [
  ...new Set(
    cloud.log
      .slice(from)
      .filter(isSnapshot)
      .map((call) => routeOf(call).split("/")[2])
  ),
];

async function pass(device, cloud) {
  const from = cloud.log.length;
  await device.service.syncAll(true);
  return snapshotsAsked(cloud, from);
}

test("the claim pages through every table once and is then finished", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const cloud = createAccountCloud();
  seedUpgradedDevice(device.db, cloud, {
    conversations: 120,
    transcriptions: 250,
    dictionary: 450,
    snippets: 410,
  });
  await device.signIn("account-a", cloud);

  assert.deepEqual(await pass(device, cloud), TABLES);
  assert.deepEqual(unclaimed(device.db), {
    conversations: 0,
    transcriptions: 0,
    dictionary: 0,
    snippets: 0,
  });
  assert.equal(localStorageStub.getItem(MARKER), null, "the claim is recorded as done");

  assert.deepEqual(await pass(device, cloud), [], "the next pass is deltas only");
});

test("a retry after a failed table repeats that table alone", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const cloud = createAccountCloud();
  seedUpgradedDevice(device.db, cloud, {
    conversations: 5,
    transcriptions: 250,
    dictionary: 5,
    snippets: 5,
  });
  await device.signIn("account-a", cloud);

  // The third page of the dictation snapshot fails.
  let pages = 0;
  cloud.failNext((call) => snapshotOf("transcriptions")(call) && ++pages === 3, { status: 500 });
  assert.deepEqual(await pass(device, cloud), TABLES);
  assert.equal(localStorageStub.getItem(MARKER), "account-a", "the device has not finished");
  assert.deepEqual(unclaimed(device.db), {
    conversations: 0,
    transcriptions: 50,
    dictionary: 0,
    snippets: 0,
  });

  assert.deepEqual(await pass(device, cloud), ["transcriptions"], "the other three are done");
  assert.equal(unclaimed(device.db).transcriptions, 0);
  assert.equal(localStorageStub.getItem(MARKER), null);
});

test("a table that fails every time is retried less and less often", async (t) => {
  const device = createSyncDevice(t);
  if (!device) return;
  const cloud = createAccountCloud();
  seedUpgradedDevice(device.db, cloud, {
    conversations: 5,
    transcriptions: 5,
    dictionary: 5,
    snippets: 5,
  });
  await device.signIn("account-a", cloud);
  cloud.failWith(snapshotOf("snippets"), { status: 500 });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const minutes = (count) => count * 60000;

  assert.deepEqual(await pass(device, cloud), TABLES, "the first pass tries them all");
  assert.deepEqual(await pass(device, cloud), ["snippets"], "one retry comes straight away");
  assert.deepEqual(await pass(device, cloud), [], "then the failing table waits");
  now += minutes(4);
  assert.deepEqual(await pass(device, cloud), []);
  now += minutes(2);
  assert.deepEqual(await pass(device, cloud), ["snippets"], "five minutes on it is tried again");
  now += minutes(6);
  assert.deepEqual(await pass(device, cloud), [], "and the wait has doubled");
  now += minutes(5);
  assert.deepEqual(await pass(device, cloud), ["snippets"]);
  assert.equal(localStorageStub.getItem(MARKER), "account-a", "the claim is still owed");

  // Weeks of failures never push the wait past an hour.
  for (let attempt = 0; attempt < 8; attempt++) {
    now += minutes(61);
    assert.deepEqual(await pass(device, cloud), ["snippets"]);
  }

  cloud.clearFailures();
  now += minutes(61);
  assert.deepEqual(await pass(device, cloud), ["snippets"]);
  assert.equal(localStorageStub.getItem(MARKER), null);
  assert.equal(unclaimed(device.db).snippets, 0);
  assert.deepEqual(await pass(device, cloud), []);
});
