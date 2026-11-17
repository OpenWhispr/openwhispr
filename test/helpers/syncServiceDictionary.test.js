// Dictionary half of SyncService over a real DatabaseManager, with only the
// HTTP boundary faked. With no saved cursor, the first pull used to read the
// server's default list, ordered by (created_at, id), then continue it on the
// (updated_at, id) delta keyset from that page's last row. Every word created
// after the first page but last edited before that row was skipped, and the
// cursor saved at the end kept it skipped on every later pass.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  localStorage: localStorageStub,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { DictionaryService } = require("../../src/services/DictionaryService.ts");

// One more page than the 200-word pull batch holds.
const WORD_COUNT = 250;
const EDITED_LAST = 199;
const T0 = Date.parse("2026-10-18T09:00:00.000Z");
const minute = (n) => new Date(T0 + n * 60_000).toISOString();

async function setup(t) {
  const db = createDb(t);
  if (!db) return null;
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  const cloud = createFakeCloud();
  windowStub.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, cloud, service };
}

function seedWords(cloud, stamp) {
  return Array.from({ length: WORD_COUNT }, (_, i) =>
    cloud.seedDictionaryEntry({ word: `word-${i}`, ...stamp(i) })
  );
}

// Words created a minute apart, then the 200th-created, the last row of the
// first page, edited after every create: it holds the newest updated_at.
const editedAfterCreates = (i) => ({
  created_at: minute(i),
  updated_at: minute(i === EDITED_LAST ? WORD_COUNT : i),
});

const listQueries = (cloud) =>
  cloud
    .logFor("/api/dictionary/list")
    .map((call) => new URLSearchParams(call.path.split("?")[1] ?? ""));

test("a fresh device pulls every word when the newest edit ends the first page", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const words = seedWords(cloud, editedAfterCreates);

  await service.syncAll(true);

  assert.equal(db.getDictionary().length, WORD_COUNT, "every cloud word reaches the device");
  assert.equal(localStorageStub.getItem("lastSyncedAt.dictionary"), words[EDITED_LAST].updated_at);
  assert.equal(localStorageStub.getItem("lastSyncedAt.dictionary.id"), words[EDITED_LAST].id);
});

test("a fresh device pages a bulk import that shares one timestamp by id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  seedWords(cloud, () => ({ created_at: minute(0), updated_at: minute(0) }));

  await service.syncAll(true);

  assert.equal(db.getDictionary().length, WORD_COUNT, "every imported word reaches the device");
});

test("the pass after a first pull streams changes from its newest word", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, service } = ctx;
  const words = seedWords(cloud, editedAfterCreates);
  await service.syncAll(true);
  const firstPassCalls = listQueries(cloud).length;

  // Another device adds one word and deletes another after that pull.
  cloud.setClock(() => minute(WORD_COUNT + 10));
  cloud.seedDictionaryEntry({ word: "added-later" });
  await cloud.request({
    method: "DELETE",
    path: "/api/dictionary/delete",
    body: { id: words[0].id },
  });
  await service.syncAll(true);

  const [delta, ...rest] = listQueries(cloud).slice(firstPassCalls);
  assert.equal(rest.length, 0, "both changes fit one delta page");
  assert.equal(delta.get("since"), words[EDITED_LAST].updated_at);
  assert.equal(delta.get("since_id"), words[EDITED_LAST].id);
  const local = db.getDictionary();
  assert.equal(local.length, WORD_COUNT);
  assert.ok(local.includes("added-later"), "the new word arrives");
  assert.ok(!local.includes(words[0].word), "the tombstone removes the deleted word");
});

const CREATED_AT = "2026-10-14 08:00:00";
const LOCAL_SECOND = "2026-10-14 09:00:00";
const SERVER_AT = "2026-10-14T09:00:00.105Z";
const NEXT_SERVER_AT = "2026-10-14T09:00:01.205Z";

function setupWrite(t, source = "manual") {
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
  const api = createElectronApi(db);
  windowStub.electronAPI = api;
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
  for (const method of ["listSnapshot", "listDelta"]) {
    t.mock.method(DictionaryService, method, async () => ({
      entries: cloud.entry ? [{ ...cloud.entry }] : [],
      hasMore: false,
    }));
  }
  t.mock.method(DictionaryService, "delete", async (id) => {
    assert.equal(id, cloud.entry.id);
    cloud.entry.deleted_at = NEXT_SERVER_AT;
  });
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  return { db, api, cloud, local, service };
}

function editInServerSecond(db, word = "ALPHA", source = "manual") {
  db.applyDictionaryChanges({ add: [word] }, source);
  // Pin SQLite's second precision below the fractional server echo without
  // depending on wall-clock timing or waiting for a second boundary.
  db.db.prepare("UPDATE custom_dictionary SET updated_at = ?").run(LOCAL_SECOND);
}

test("an unchanged dictionary create acknowledges the server revision and preserves creation time", async (t) => {
  const ctx = setupWrite(t);
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

for (const kind of ["create ACK", "in-flight create edit", "cloud merge"]) {
  test(`manual dictionary provenance survives ${kind} and a subsequent learned casing edit`, async (t) => {
    const ctx = setupWrite(t, "learned");
    if (!ctx) return;
    const { db, api, cloud, local, service } = ctx;
    if (kind === "cloud merge") {
      await service.syncDictionary();
      cloud.entry.source = "manual";
      cloud.entry.updated_at = NEXT_SERVER_AT;
      api.upsertDictionaryFromCloud = async (entry) => {
        editInServerSecond(db, "ALPHA", "learned");
        return db.upsertDictionaryFromCloud(entry);
      };
      await service.pullDictionary();
    } else {
      cloud.afterWrite = () => {
        // A batch-create deduplicated against a manual word keeps its source.
        cloud.entry.source = "manual";
        if (kind === "in-flight create edit") editInServerSecond(db, "ALPHA", "learned");
        cloud.afterWrite = () => {};
      };
      await service.syncDictionary();
    }

    const row = db.getDictionaryEntryByClientId(local.client_dict_id);
    assert.equal(row.source, "manual");
    assert.equal(row.word, kind === "create ACK" ? "alpha" : "ALPHA");
    assert.equal(row.created_at, CREATED_AT);
    assert.equal(row.updated_at, kind === "create ACK" ? SERVER_AT : LOCAL_SECOND);
    assert.equal(row.sync_status, kind === "create ACK" ? "synced" : "pending");
    assert.equal(row.cloud_id, cloud.entry.id);

    if (kind === "create ACK") editInServerSecond(db, "ALPHA", "learned");
    await service.syncDictionary();
    assert.equal(cloud.entry.word, "ALPHA");
    assert.equal(cloud.entry.source, "manual");
    assert.equal(db.getDictionaryEntryByClientId(local.client_dict_id).sync_status, "synced");
    assert.equal(DictionaryService.delete.mock.callCount(), 0);
    assert.equal(DictionaryService.batchCreate.mock.callCount(), 1);
    assert.equal(DictionaryService.update.mock.callCount(), 1);
  });
}

test("a same-second casing edit after create ACK survives the echo and reaches the next PATCH", async (t) => {
  const ctx = setupWrite(t);
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
    const ctx = setupWrite(t, kind === "source promotion" ? "learned" : "manual");
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
  const ctx = setupWrite(t);
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
    const ctx = setupWrite(t);
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
