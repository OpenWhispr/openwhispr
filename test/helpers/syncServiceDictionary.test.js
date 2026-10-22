const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  stopSyncTimers,
  window: browserWindow,
} = require("./harness/browserGlobals.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { DictionaryService } = require("../../src/services/DictionaryService.ts");

const CREATED_AT = "2026-10-14 08:00:00";
const LOCAL_SECOND = "2026-10-14 09:00:00";
const SERVER_AT = "2026-10-14T09:00:00.105Z";
const NEXT_SERVER_AT = "2026-10-14T09:00:01.205Z";

function setup(t, source = "manual") {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  db.setDictionary(["alpha"], source);
  db.db
    .prepare("UPDATE custom_dictionary SET created_at = ?, updated_at = ?")
    .run(CREATED_AT, CREATED_AT);
  const [local] = db.getPendingDictionary();
  const cloud = { entry: null, afterWrite: () => {} };
  const api = {
    getPendingDictionary: async () => db.getPendingDictionary(),
    getPendingDictionaryDeletes: async () => db.getPendingDictionaryDeletes(),
    getDictionaryByClientId: async (id) => db.getDictionaryEntryByClientId(id),
    upsertDictionaryFromCloud: async (entry) => db.upsertDictionaryFromCloud(entry),
    markDictionarySynced: async (...args) => db.markDictionaryEntrySynced(...args),
    hardDeleteDictionary: async (id) => db.hardDeleteDictionaryEntry(id),
    clearDictionaryCloudId: async (id) => db.clearDictionaryCloudId(id),
    broadcastDictionaryUpdated: async () => ({ success: true }),
  };
  browserWindow.electronAPI = api;
  t.mock.method(DictionaryService, "batchCreate", async ([entry]) => {
    cloud.entry = { ...entry, id: "cloud-alpha", deleted_at: null, updated_at: SERVER_AT };
    cloud.afterWrite();
    return { created: [{ ...cloud.entry }] };
  });
  t.mock.method(DictionaryService, "update", async (id, fields) => {
    assert.equal(id, cloud.entry.id);
    cloud.entry = { ...cloud.entry, ...fields, updated_at: NEXT_SERVER_AT };
    cloud.afterWrite();
    return { ...cloud.entry };
  });
  t.mock.method(DictionaryService, "list", async () => ({
    entries: cloud.entry ? [{ ...cloud.entry }] : [],
    hasMore: false,
  }));
  t.mock.method(DictionaryService, "delete", async (id) => {
    assert.equal(id, cloud.entry.id);
    cloud.entry.deleted_at = NEXT_SERVER_AT;
  });
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, api, cloud, local, service };
}

function editInServerSecond(db, word = "ALPHA") {
  db.applyDictionaryChanges({ add: [word] });
  // Pin SQLite's second precision below the fractional server echo without
  // depending on wall-clock timing or waiting for a second boundary.
  db.db.prepare("UPDATE custom_dictionary SET updated_at = ?").run(LOCAL_SECOND);
}

test("an unchanged dictionary create acknowledges the server revision and preserves creation time", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, local, service } = ctx;
  await service.pushPendingDictionary();

  const row = db.getDictionaryEntryByClientId(local.client_dict_id);
  assert.equal(row.word, "alpha");
  assert.equal(row.source, "manual");
  assert.equal(row.created_at, CREATED_AT);
  assert.equal(row.updated_at, SERVER_AT);
  assert.equal(row.sync_status, "synced");
  assert.equal(row.cloud_id, "cloud-alpha");
  await service.pullDictionary();
  assert.deepEqual(db.getDictionaryEntryByClientId(local.client_dict_id), row);
});

test("a same-second casing edit after create ACK survives the echo and reaches the next PATCH", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, api, cloud, local, service } = ctx;
  const acknowledge = api.markDictionarySynced;
  api.markDictionarySynced = async (...args) => {
    const result = await acknowledge(...args);
    editInServerSecond(db);
    api.markDictionarySynced = acknowledge;
    return result;
  };

  await service.syncDictionary();
  const row = db.getDictionaryEntryByClientId(local.client_dict_id);
  assert.equal(row.word, "ALPHA");
  assert.equal(row.sync_status, "pending");
  assert.equal(row.updated_at, LOCAL_SECOND);
  assert.equal(row.cloud_id, cloud.entry.id);
  assert.equal(DictionaryService.delete.mock.callCount(), 0);

  await service.syncDictionary();
  assert.equal(cloud.entry.word, "ALPHA");
  assert.equal(db.getDictionaryEntryByClientId(local.client_dict_id).sync_status, "synced");
  assert.equal(DictionaryService.batchCreate.mock.callCount(), 1);
  assert.equal(DictionaryService.update.mock.callCount(), 1);
});

for (const kind of ["create", "PATCH", "source promotion"]) {
  test(`a dictionary edit during ${kind} stays pending without deleting its cloud row`, async (t) => {
    const ctx = setup(t, kind === "source promotion" ? "learned" : "manual");
    if (!ctx) return;
    const { db, cloud, local, service } = ctx;
    if (kind === "PATCH") {
      await service.syncDictionary();
      db.applyDictionaryChanges({ add: ["Alpha"] });
    }
    cloud.afterWrite = () => {
      editInServerSecond(db, kind === "source promotion" ? "alpha" : "ALPHA");
      cloud.afterWrite = () => {};
    };

    await service.syncDictionary();
    const row = db.getDictionaryEntryByClientId(local.client_dict_id);
    assert.equal(row.word, kind === "source promotion" ? "alpha" : "ALPHA");
    assert.equal(row.source, "manual");
    assert.equal(row.sync_status, "pending");
    assert.equal(row.updated_at, LOCAL_SECOND);
    assert.equal(row.cloud_id, cloud.entry.id);
    assert.equal(DictionaryService.delete.mock.callCount(), 0);

    await service.syncDictionary();
    assert.equal(cloud.entry.word, row.word);
    assert.equal(cloud.entry.source, "manual");
    assert.equal(db.getDictionaryEntryByClientId(local.client_dict_id).sync_status, "synced");
    assert.equal(DictionaryService.batchCreate.mock.callCount(), 1);
  });
}

test("an edit between dictionary pull lookup and SQLite merge survives a newer cloud copy", async (t) => {
  const ctx = setup(t);
  if (!ctx) return;
  const { db, api, cloud, local, service } = ctx;
  await service.syncDictionary();
  cloud.entry.updated_at = NEXT_SERVER_AT;
  api.upsertDictionaryFromCloud = async (entry) => {
    editInServerSecond(db);
    return db.upsertDictionaryFromCloud(entry);
  };

  await service.pullDictionary();
  const row = db.getDictionaryEntryByClientId(local.client_dict_id);
  assert.equal(row.word, "ALPHA");
  assert.equal(row.sync_status, "pending");
  assert.equal(row.updated_at, LOCAL_SECOND);
});

for (const kind of ["create", "PATCH"]) {
  test(`a dictionary deletion during ${kind} still cleans up the cloud row`, async (t) => {
    const ctx = setup(t);
    if (!ctx) return;
    const { db, cloud, local, service } = ctx;
    if (kind === "PATCH") {
      await service.syncDictionary();
      db.applyDictionaryChanges({ add: ["ALPHA"] });
    }
    cloud.afterWrite = () => db.applyDictionaryChanges({ remove: ["alpha"] });

    await service.syncDictionary();
    assert.equal(db.getDictionaryEntryByClientId(local.client_dict_id), null);
    assert.ok(cloud.entry.deleted_at);
    assert.equal(DictionaryService.delete.mock.callCount(), 1);
    assert.deepEqual(db.getDictionary(), []);
  });
}
