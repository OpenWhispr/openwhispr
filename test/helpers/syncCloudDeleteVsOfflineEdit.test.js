// A word or snippet edited offline after its cloud copy was deleted. On a device
// another account has used, the PATCH 404 parks an unattributed row with its
// cloud id, and the pull then brings that id's tombstone from this account's
// cloud. The tombstone proves the row is this account's; an edit newer than it
// is kept and re-created, while a synced, unedited row still goes. Real
// DatabaseManager and SyncService; only HTTP is faked.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");

const A = "account-a";
const DELETED_AT = "2026-01-01T00:00:00.000Z";

const KINDS = {
  dictionary: {
    table: "custom_dictionary",
    clientKey: "client_dict_id",
    deleteRoute: "/api/dictionary/delete",
    seedLive: (cloud) => cloud.seedDictionaryEntry({ word: "Beta", client_dict_id: "a-beta" }),
    seed: (cloud) => cloud.seedDictionaryEntry({ word: "Alpha", client_dict_id: "legacy-row" }),
    insertLocal: (db, cloudId) =>
      db.db
        .prepare(
          `INSERT INTO custom_dictionary (word, client_dict_id, cloud_id, sync_status, updated_at, legacy_unattributed)
           VALUES ('Alpha', 'legacy-row', ?, 'synced', '2025-12-01 00:00:00', 1)`
        )
        .run(cloudId),
    edit: (db) =>
      db.db
        .prepare(
          "UPDATE custom_dictionary SET word = 'Alpha edited', sync_status = 'pending', updated_at = datetime('now') WHERE client_dict_id = 'legacy-row'"
        )
        .run(),
    edited: "Alpha edited",
    cloudRows: (cloud) => cloud.dictionary(),
    text: (row) => row.word,
  },
  snippets: {
    table: "snippets",
    clientKey: "client_snippet_id",
    deleteRoute: "/api/snippets/delete",
    seedLive: (cloud) =>
      cloud.seedSnippet({ trigger: "sig", replacement: "Best", client_snippet_id: "a-sig" }),
    seed: (cloud) =>
      cloud.seedSnippet({ trigger: "addr", replacement: "old", client_snippet_id: "legacy-row" }),
    insertLocal: (db, cloudId) =>
      db.db
        .prepare(
          `INSERT INTO snippets (trigger, replacement, client_snippet_id, cloud_id, sync_status, updated_at, legacy_unattributed)
           VALUES ('addr', 'old', 'legacy-row', ?, 'synced', '2025-12-01 00:00:00', 1)`
        )
        .run(cloudId),
    edit: (db) =>
      db.db
        .prepare(
          "UPDATE snippets SET replacement = 'new address', sync_status = 'pending', updated_at = datetime('now') WHERE client_snippet_id = 'legacy-row'"
        )
        .run(),
    edited: "new address",
    cloudRows: (cloud) => cloud.snippets(),
    text: (row) => row.replacement,
  },
};

// A's cloud deleted the row before this device's first pull; the device still
// holds it from before attribution, with that cloud id, on a device another
// account has used.
async function setUp(t, kind) {
  const device = createSyncDevice(t);
  if (!device) return null;
  const { db } = device;
  const cloud = createAccountCloud();
  cloud.setClock(() => DELETED_AT);
  kind.seedLive(cloud);
  const seeded = kind.seed(cloud);
  await cloud.request({ method: "DELETE", path: kind.deleteRoute, body: { id: seeded.id } });
  cloud.setClock(() => new Date().toISOString());
  kind.insertLocal(db, seeded.id);
  db.db
    .prepare(
      "INSERT INTO analytics_events (event_id, account_id, occurred_at, local_date, word_count, mode) VALUES ('b-trace', 'account-b', ?, '2026-01-01', 1, 'local')"
    )
    .run(DELETED_AT);
  await device.signIn(A, cloud);
  return { device, db, cloud };
}

const localRow = (db, kind) =>
  db.db.prepare(`SELECT * FROM ${kind.table} WHERE ${kind.clientKey} = 'legacy-row'`).get();

for (const [name, kind] of Object.entries(KINDS)) {
  test(`${name}: an offline edit newer than this account's cloud deletion is kept and re-created`, async (t) => {
    const setup = await setUp(t, kind);
    if (!setup) return;
    const { device, db, cloud } = setup;
    kind.edit(db);
    // The PATCH 404s, which parks the row; a pull brings the cloud's older
    // tombstone (a word's first pull, from the epoch, or a snippet's next one).
    await device.service.syncAll(true);
    await device.service.syncAll(true);
    const kept = localRow(db, kind);
    assert.ok(kept, "the newer edit outlives the older deletion");
    assert.equal(kind.text(kept), kind.edited);
    assert.equal(kept.account_id, A, "the tombstone proved whose row it is");
    assert.equal(kept.deleted_at, null);

    await device.service.syncAll(true);
    assert.ok(
      kind.cloudRows(cloud).some((row) => !row.deleted_at && kind.text(row) === kind.edited),
      "the next push puts the edit back in the account's cloud"
    );
    assert.equal(localRow(db, kind).sync_status, "synced");
  });

  test(`${name}: a synced, unedited row is still removed by its cloud deletion`, async (t) => {
    const setup = await setUp(t, kind);
    if (!setup) return;
    const { device, db } = setup;
    await device.service.syncAll(true);
    await device.service.syncAll(true);
    assert.equal(localRow(db, kind), undefined);
  });
}
