// A word or snippet whose update answers 404 is parked only when it may be
// another account's row. The account's own row is never parked: a park lasts
// until the row is edited again, and nothing else would ever send its edit.
// That includes the 404 whose follow-up write main refuses because the sign-in
// ended in between, which decides nothing about the row. Real DatabaseManager
// and SyncService on one window; only HTTP is faked.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSyncDevice, routeOf } = require("./harness/syncDevice.js");
const { createAccountCloud } = require("./harness/fakeCloud.js");

const KINDS = {
  dictionary: {
    table: "custom_dictionary",
    update: "/api/dictionary/update",
    clear: "clearDictionaryCloudId",
    seed: (cloud) => cloud.seedDictionaryEntry({ word: "Alpha", client_dict_id: "a-word" }),
    edit: (db) =>
      db.db
        .prepare(
          "UPDATE custom_dictionary SET word = 'Alpha2', sync_status = 'pending', updated_at = datetime('now')"
        )
        .run(),
  },
  snippets: {
    table: "snippets",
    update: "/api/snippets/update",
    clear: "clearSnippetCloudId",
    seed: (cloud) =>
      cloud.seedSnippet({ trigger: "addr", replacement: "old", client_snippet_id: "a-snippet" }),
    edit: (db) =>
      db.db
        .prepare(
          "UPDATE snippets SET replacement = 'new', sync_status = 'pending', updated_at = datetime('now')"
        )
        .run(),
  },
};

for (const [kind, { table, update, clear, seed, edit }] of Object.entries(KINDS)) {
  test(`${kind}: the account's own row is not parked when its sign-in ends after the 404`, async (t) => {
    const device = createSyncDevice(t);
    if (!device) return;
    const { db, api } = device;
    const cloud = createAccountCloud();
    seed(cloud);
    await device.signIn("account-a", cloud);
    await device.service.syncAll(true);
    edit(db);
    cloud.failWith(`PATCH ${update}`, { status: 404 });

    // The token is cleared after main answered the update and before the
    // follow-up write arrives.
    const clearCloudId = api[clear];
    api[clear] = async (...args) => {
      api[clear] = clearCloudId;
      device.signOut();
      return clearCloudId(...args);
    };
    await device.service.syncAll(true);
    const row = () => db.db.prepare(`SELECT account_id, cloud_id, sync_status FROM ${table}`).get();
    assert.equal(row().sync_status, "pending", "the refused write changed nothing");

    cloud.clearFailures();
    await device.signIn("account-a", cloud);
    const from = cloud.log.length;
    await device.service.syncAll(true);
    assert.equal(
      cloud.log.slice(from).filter((call) => routeOf(call) === update).length,
      1,
      "its next pass sends the edit again"
    );
    assert.equal(row().sync_status, "synced");
  });
}
