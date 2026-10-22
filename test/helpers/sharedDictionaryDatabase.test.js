const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-shared-dict-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-shared-dict-db-"));
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const SPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function entry(id, word, overrides = {}) {
  return {
    id,
    workspace_id: WS,
    space_id: null,
    word,
    added_by_user_id: "user-1",
    created_at: "2026-10-20T10:00:00.000Z",
    updated_at: "2026-10-20T10:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

function scope(spaceId, name = "List") {
  return { space_id: spaceId, name, member_count: 3, word_count: 1 };
}

function meta(scopes) {
  return {
    scopes,
    contributors: [{ user_id: "user-1", name: "Ada", is_member: true }],
    paused: false,
  };
}

function words(snapshot) {
  return snapshot.entries.map((e) => e.word).sort();
}

test("apply pull upserts and deletes", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applySharedDictionaryPull(WS, {
    upserts: [entry("e1", "Qdrant"), entry("e2", "Parakeet", { space_id: SPACE_A })],
    deletedIds: [],
  });
  let snapshot = db.getSharedDictionary(WS);
  assert.deepEqual(words(snapshot), ["Parakeet", "Qdrant"]);
  assert.equal(snapshot.meta, null);
  const parakeet = snapshot.entries.find((e) => e.cloudId === "e2");
  assert.deepEqual(parakeet, {
    cloudId: "e2",
    spaceId: SPACE_A,
    word: "Parakeet",
    addedByUserId: "user-1",
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
  });

  const result = db.applySharedDictionaryPull(WS, {
    upserts: [entry("e1", "QDrant", { updated_at: "2026-10-20T11:00:00.000Z" })],
    deletedIds: ["e2"],
  });
  assert.equal(result.changed, 2);
  snapshot = db.getSharedDictionary(WS);
  assert.deepEqual(words(snapshot), ["QDrant"]);

  // Re-applying the same rows (the 10 s read overlap) changes nothing.
  const again = db.applySharedDictionaryPull(WS, {
    upserts: [entry("e1", "QDrant", { updated_at: "2026-10-20T11:00:00.000Z" })],
    deletedIds: ["e2"],
  });
  assert.equal(again.changed, 0);

  // Another workspace's rows are untouched by this workspace's pull.
  db.applySharedDictionaryPull(OTHER_WS, {
    upserts: [entry("o1", "Other", { workspace_id: OTHER_WS })],
    deletedIds: [],
  });
  assert.deepEqual(words(db.getSharedDictionary(WS)), ["QDrant"]);
  assert.deepEqual(words(db.getSharedDictionary(OTHER_WS)), ["Other"]);
});

test("meta prunes words of spaces no longer in scopes", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applySharedDictionaryPull(WS, {
    upserts: [
      entry("w1", "Workspace word"),
      entry("a1", "Space A word", { space_id: SPACE_A }),
      entry("b1", "Space B word", { space_id: SPACE_B }),
    ],
    deletedIds: [],
    meta: meta([scope(null), scope(SPACE_A), scope(SPACE_B)]),
  });
  db.applySharedDictionaryHides(WS, {
    hidden: [{ entryId: "b1", updatedAt: "2026-10-20T10:00:00.000Z" }],
    unhidden: [],
  });

  db.applySharedDictionaryPull(WS, {
    upserts: [],
    deletedIds: [],
    meta: meta([scope(null), scope(SPACE_A)]),
  });

  const snapshot = db.getSharedDictionary(WS);
  assert.deepEqual(words(snapshot), ["Space A word", "Workspace word"]);
  assert.deepEqual(
    snapshot.meta.scopes.map((s) => s.space_id),
    [null, SPACE_A]
  );
  assert.deepEqual(snapshot.meta.contributors, [
    { user_id: "user-1", name: "Ada", is_member: true },
  ]);
  assert.equal(snapshot.meta.paused, false);
  assert.equal(typeof snapshot.meta.syncedAt, "string");
  assert.deepEqual(snapshot.hiddenIds, []);
});

test("deleting an entry removes its hide", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applySharedDictionaryPull(WS, {
    upserts: [entry("e1", "Qdrant"), entry("e2", "Parakeet")],
    deletedIds: [],
  });
  db.applySharedDictionaryHides(WS, {
    hidden: [
      { entryId: "e1", updatedAt: "2026-10-20T10:00:00.000Z" },
      { entryId: "e2", updatedAt: "2026-10-20T10:00:00.000Z" },
    ],
    unhidden: [],
  });
  assert.deepEqual(db.getSharedDictionary(WS).hiddenIds.sort(), ["e1", "e2"]);

  db.applySharedDictionaryPull(WS, { upserts: [], deletedIds: ["e1"] });
  assert.deepEqual(db.getSharedDictionary(WS).hiddenIds, ["e2"]);

  const unhide = db.applySharedDictionaryHides(WS, { hidden: [], unhidden: ["e2"] });
  assert.equal(unhide.changed, 1);
  assert.deepEqual(db.getSharedDictionary(WS).hiddenIds, []);
});

test("replaceSharedDictionaryHides makes the workspace's hides exactly the given list", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applySharedDictionaryHides(WS, {
    hidden: [
      { entryId: "e1", updatedAt: "2026-10-20T10:00:00.000Z" },
      { entryId: "e2", updatedAt: "2026-10-20T10:00:00.000Z" },
    ],
    unhidden: [],
  });
  db.applySharedDictionaryHides(OTHER_WS, {
    hidden: [{ entryId: "o1", updatedAt: "2026-10-20T10:00:00.000Z" }],
    unhidden: [],
  });

  db.replaceSharedDictionaryHides(WS, [
    { entryId: "e2", updatedAt: "2026-10-20T11:00:00.000Z" },
    { entryId: "e3", updatedAt: "2026-10-20T11:00:00.000Z" },
  ]);
  assert.deepEqual(db.getSharedDictionary(WS).hiddenIds.sort(), ["e2", "e3"]);
  assert.deepEqual(db.getSharedDictionary(OTHER_WS).hiddenIds, ["o1"]);
});

test("markDictionaryWordsShared keeps the word live", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    source: "manual",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T09:00:00.000Z",
  });
  db.applyDictionaryChanges({ add: ["Parakeet"] });
  const before = db.getDictionaryEntryByClientId("client-1");

  const result = db.markDictionaryWordsShared(["qdrant", "Missing"], "2026-10-20T12:00:00.000Z");
  assert.deepEqual(result, { marked: ["Qdrant"] });

  assert.deepEqual(db.getDictionary(), ["Qdrant", "Parakeet"]);
  assert.deepEqual(db.getMovedDictionaryWords(), ["Qdrant"]);
  assert.deepEqual(db.getPendingDictionaryDeletes(), []);

  const after = db.getDictionaryEntryByClientId("client-1");
  assert.equal(after.shared_at, "2026-10-20T12:00:00.000Z");
  assert.equal(after.sync_status, "synced");
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.deleted_at, null);
  assert.deepEqual(
    db.getPendingDictionary().map((row) => row.word),
    ["Parakeet"]
  );
});

// Backup off and the personal row changed elsewhere: the word went as a plain
// word, so the server's personal row never got shared_at.
test("markDictionaryWordsShared leaves words that went plain pending and dirty", (t) => {
  const db = createDb(t);
  if (!db) return;

  for (const [id, word] of [
    ["cloud-1", "Qdrant"],
    ["cloud-2", "Orukeet"],
  ]) {
    db.upsertDictionaryFromCloud({
      id,
      client_dict_id: `client-${id}`,
      word,
      source: "manual",
      created_at: "2026-10-20T09:00:00.000Z",
      updated_at: "2026-10-20T09:00:00.000Z",
    });
  }

  db.markDictionaryWordsShared(["Qdrant", "Orukeet"], "2026-10-20T12:00:00.000Z", {
    pendingWords: ["orukeet"],
  });

  const plain = db.getDictionaryEntryByClientId("client-cloud-2");
  assert.equal(plain.shared_at, "2026-10-20T12:00:00.000Z");
  assert.equal(plain.shared_at_dirty, 1);
  assert.equal(plain.sync_status, "pending");
  const linked = db.getDictionaryEntryByClientId("client-cloud-1");
  assert.equal(linked.shared_at_dirty, 0);
  assert.equal(linked.sync_status, "synced");
  assert.deepEqual(
    db.getPendingDictionary().map((row) => [row.word, row.shared_at_dirty]),
    [["Orukeet", 1]]
  );
});

test("retireMovedDictionaryWords removes only moved rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  for (const [index, word] of ["Qdrant", "Parakeet"].entries()) {
    db.upsertDictionaryFromCloud({
      id: `cloud-${index}`,
      client_dict_id: `client-${index}`,
      word,
      source: "manual",
      created_at: "2026-10-20T09:00:00.000Z",
      updated_at: "2026-10-20T09:00:00.000Z",
    });
  }
  db.applyDictionaryChanges({ add: ["Orukeet", "Kubernetes"] });
  db.markDictionaryWordsShared(["Qdrant", "Orukeet"], "2026-10-20T12:00:00.000Z");

  const result = db.retireMovedDictionaryWords([
    "qdrant",
    "Orukeet",
    "Parakeet",
    "Kubernetes",
    "Missing",
  ]);

  assert.deepEqual(result, { retired: ["Qdrant", "Orukeet"] });
  assert.deepEqual(db.getDictionary(), ["Parakeet", "Kubernetes"]);
  assert.deepEqual(db.getMovedDictionaryWords(), []);
  // Neither tombstone is pushed: the server retires the synced row itself (or
  // keeps it, when the word still applies somewhere this device never saw),
  // and a never-synced row has nothing to delete.
  assert.deepEqual(db.getPendingDictionaryDeletes(), []);
  const qdrant = db.getDictionaryEntryByClientId("client-0");
  assert.deepEqual(
    [qdrant.sync_status, qdrant.fallback_retired, qdrant.deleted_at !== null],
    ["synced", 1, true]
  );
  assert.deepEqual(
    db.getPendingDictionary().map((row) => row.word),
    ["Kubernetes"]
  );
  assert.equal(db.getDictionaryEntryByClientId("client-1").deleted_at, null);
  assert.deepEqual(db.retireMovedDictionaryWords(["Qdrant"]), { retired: [] });
});

test("with sync on, retirement leaves synced rows to the pull", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertDictionaryFromCloud({
    id: "cloud-0",
    client_dict_id: "client-0",
    word: "Qdrant",
    shared_at: "2026-10-20T12:00:00.000Z",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
  });
  db.applyDictionaryChanges({ add: ["Orukeet"] });
  db.markDictionaryWordsShared(["Orukeet"], "2026-10-20T12:00:00.000Z");

  const result = db.retireMovedDictionaryWords(["Qdrant", "Orukeet"], { includeSynced: false });

  assert.deepEqual(result, { retired: ["Orukeet"] });
  assert.deepEqual(db.getDictionary(), ["Qdrant"]);
});

test("reviveRetiredDictionaryWords undoes a retirement, and nothing else", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertDictionaryFromCloud({
    id: "cloud-0",
    client_dict_id: "client-0",
    word: "Qdrant",
    source: "manual",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T09:00:00.000Z",
  });
  db.applyDictionaryChanges({ add: ["Orukeet", "Kubernetes", "Parakeet"] });
  db.markDictionaryWordsShared(["Qdrant", "Orukeet", "Parakeet"], "2026-10-20T12:00:00.000Z");
  db.retireMovedDictionaryWords(["Qdrant", "Orukeet", "Parakeet"]);
  // A deliberate delete is not a retirement, and a re-add already covers its word.
  db.applyDictionaryChanges({ remove: ["Kubernetes"] });
  db.applyDictionaryChanges({ add: ["parakeet"] });

  const result = db.reviveRetiredDictionaryWords(["qdrant", "Orukeet", "Parakeet", "Kubernetes"]);

  assert.deepEqual(result, { revived: ["Qdrant", "Orukeet"] });
  assert.deepEqual(db.getDictionary(), ["Qdrant", "Orukeet", "parakeet"]);
  const qdrant = db.getDictionaryEntryByClientId("client-0");
  assert.equal(qdrant.sync_status, "synced", "the server owns the revive; the pull reconciles");
  assert.equal(qdrant.shared_at, "2026-10-20T12:00:00.000Z");
  assert.deepEqual(
    db
      .getPendingDictionary()
      .map((row) => row.word)
      .sort(),
    ["Orukeet", "parakeet"],
    "a never-synced row is a pending create again"
  );
  assert.deepEqual(db.reviveRetiredDictionaryWords(["Qdrant"]), { revived: [] });
});

test("a push ack clears the marker only for the row it pushed", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    shared_at: "2026-10-20T12:00:00.000Z",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
  });
  db.applyDictionaryChanges({ add: ["Qdrant"] }); // un-share: dirty, pending
  const pushed = db.getDictionaryEntryByClientId("client-1");
  // While that push is in flight, the user renames the word.
  db.applyDictionaryChanges({ add: ["QDRANT"] });

  const result = db.markDictionaryEntrySynced(pushed.id, "cloud-1", {
    word: pushed.word,
    shared_at: pushed.shared_at,
    updated_at: pushed.updated_at,
  });

  const row = db.getDictionaryEntryByClientId("client-1");
  assert.equal(result.changes, 1);
  assert.deepEqual([row.sync_status, row.shared_at_dirty], ["pending", 1], "pushed again");

  const again = db.getDictionaryEntryByClientId("client-1");
  db.markDictionaryEntrySynced(again.id, "cloud-1", {
    word: again.word,
    shared_at: again.shared_at,
    updated_at: again.updated_at,
  });
  const done = db.getDictionaryEntryByClientId("client-1");
  assert.deepEqual([done.sync_status, done.shared_at_dirty], ["synced", 0]);
});

test("shared_at is dirty only while a local set or clear awaits its push", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    source: "learned",
    shared_at: "2026-10-20T12:00:00.000Z",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
  });
  const dirty = () => db.getDictionaryEntryByClientId("client-1").shared_at_dirty;
  assert.equal(dirty(), 0);

  // An ordinary edit (here a learned word promoted to manual) leaves the marker alone.
  db.applyDictionaryChanges({ add: ["Qdrant"] }, "manual");
  assert.equal(dirty(), 1, "an explicit add takes the word back into Personal");
  db.markDictionaryEntrySynced(db.getDictionaryEntryByClientId("client-1").id, "cloud-1");
  assert.equal(dirty(), 0, "the push carried it");

  db.markDictionaryWordsShared(["Qdrant"], "2026-10-20T13:00:00.000Z");
  assert.equal(dirty(), 0, "the server recorded the share itself");

  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    source: "learned",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T14:00:00.000Z",
  });
  db.applyDictionaryChanges({ remove: ["Qdrant"] });
  db.applyDictionaryChanges({ add: ["Qdrant"] });
  assert.equal(dirty(), 1, "a restored word is sent as personal");

  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    shared_at: null,
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T15:00:00.000Z",
  });
  assert.equal(dirty(), 0, "the cloud's row replaces the local change");

  db.applyDictionaryChanges({ add: ["Parakeet"] });
  const parakeet = db.getPendingDictionary().find((row) => row.word === "Parakeet");
  assert.equal(parakeet.shared_at_dirty, 0, "a new word has nothing to clear");
});

test("replaceSharedDictionary removes entries absent from the snapshot", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.applySharedDictionaryPull(WS, {
    upserts: [entry("e1", "Kept"), entry("e2", "Gone"), entry("e3", "Renamed")],
    deletedIds: [],
    meta: meta([scope(null)]),
  });
  db.applySharedDictionaryHides(WS, {
    hidden: [
      { entryId: "e1", updatedAt: "2026-10-20T10:00:00.000Z" },
      { entryId: "e2", updatedAt: "2026-10-20T10:00:00.000Z" },
    ],
    unhidden: [],
  });
  db.applySharedDictionaryPull(OTHER_WS, {
    upserts: [entry("o1", "Other", { workspace_id: OTHER_WS })],
    deletedIds: [],
  });

  const result = db.replaceSharedDictionary(WS, {
    entries: [
      entry("e1", "Kept"),
      entry("e3", "Renamed word", { updated_at: "2026-10-20T11:00:00.000Z" }),
      entry("e4", "New", { space_id: SPACE_A }),
    ],
    meta: { ...meta([scope(null), scope(SPACE_A)]), paused: true },
  });
  // e2 deleted, e3 updated, e4 inserted; e1 unchanged.
  assert.equal(result.changed, 3);

  const snapshot = db.getSharedDictionary(WS);
  assert.deepEqual(words(snapshot), ["Kept", "New", "Renamed word"]);
  assert.deepEqual(snapshot.hiddenIds, ["e1"]);
  assert.equal(snapshot.meta.paused, true);
  assert.deepEqual(
    snapshot.meta.scopes.map((s) => s.space_id),
    [null, SPACE_A]
  );
  assert.deepEqual(words(db.getSharedDictionary(OTHER_WS)), ["Other"]);
});

test("upsertDictionaryFromCloud stores shared_at, and a local re-add clears it", (t) => {
  const db = createDb(t);
  if (!db) return;

  const row = db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    source: "manual",
    shared_at: "2026-10-20T12:00:00.000Z",
    created_at: "2026-10-20T09:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
  });
  assert.equal(row.shared_at, "2026-10-20T12:00:00.000Z");
  assert.deepEqual(db.getMovedDictionaryWords(), ["Qdrant"]);

  // A pull without the field (an older API) leaves the local value alone.
  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    updated_at: "2026-10-20T12:00:00.000Z",
  });
  assert.equal(db.getDictionaryEntryByClientId("client-1").shared_at, "2026-10-20T12:00:00.000Z");

  // A whole-list write that merely keeps the word isn't a re-add.
  db.setDictionary(["Qdrant"]);
  assert.deepEqual(db.getMovedDictionaryWords(), ["Qdrant"]);

  db.applyDictionaryChanges({ add: ["qdrant"] });
  const readded = db.getDictionaryEntryByClientId("client-1");
  assert.equal(readded.shared_at, null);
  assert.equal(readded.sync_status, "pending");
  assert.deepEqual(db.getMovedDictionaryWords(), []);
  const pending = db.getPendingDictionary();
  assert.equal(pending.length, 1);
  assert.ok(Object.hasOwn(pending[0], "shared_at"));
  assert.equal(pending[0].shared_at, null);

  // A cloud null clears it too, and a deleted-then-restored word comes back unmoved.
  db.markDictionaryWordsShared(["Qdrant"], "2026-10-20T13:00:00.000Z");
  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "Qdrant",
    shared_at: null,
    updated_at: "2026-10-20T13:00:00.000Z",
  });
  assert.deepEqual(db.getMovedDictionaryWords(), []);

  db.markDictionaryWordsShared(["Qdrant"], "2026-10-20T14:00:00.000Z");
  db.applyDictionaryChanges({ remove: ["Qdrant"] });
  assert.deepEqual(db.getMovedDictionaryWords(), []);
  db.applyDictionaryChanges({ add: ["Qdrant"] });
  assert.equal(db.getDictionaryEntryByClientId("client-1").shared_at, null);
});

test("getDictionaryEntriesByWords matches case-insensitively", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertDictionaryFromCloud({
    id: "cloud-1",
    client_dict_id: "client-1",
    word: "OpenWhispr",
    updated_at: "2026-10-20T09:00:00.000Z",
  });
  db.applyDictionaryChanges({ add: ["Parakeet", "Removed"] });
  db.applyDictionaryChanges({ remove: ["Removed"] });

  const result = db.getDictionaryEntriesByWords(["openwhispr", "PARAKEET", "removed", "missing"]);
  assert.deepEqual(result, [
    { word: "OpenWhispr", cloudId: "cloud-1" },
    { word: "Parakeet", cloudId: null },
  ]);
  assert.deepEqual(db.getDictionaryEntriesByWords([]), []);
});

test("clearSharedDictionary() empties all three tables", (t) => {
  const db = createDb(t);
  if (!db) return;

  for (const ws of [WS, OTHER_WS]) {
    db.applySharedDictionaryPull(ws, {
      upserts: [entry(`${ws}-e1`, "Qdrant", { workspace_id: ws })],
      deletedIds: [],
      meta: meta([scope(null)]),
    });
    db.applySharedDictionaryHides(ws, {
      hidden: [{ entryId: `${ws}-e1`, updatedAt: "2026-10-20T10:00:00.000Z" }],
      unhidden: [],
    });
  }

  assert.deepEqual(db.clearSharedDictionary(WS), { changed: 3 }, "entry, hide and meta");
  assert.deepEqual(db.getSharedDictionary(WS), { entries: [], hiddenIds: [], meta: null });
  assert.equal(db.getSharedDictionary(OTHER_WS).entries.length, 1);
  assert.deepEqual(db.clearSharedDictionary(WS), { changed: 0 });

  db.clearSharedDictionary();
  assert.deepEqual(db.getSharedDictionary(OTHER_WS), { entries: [], hiddenIds: [], meta: null });
});

test("pruneSharedDictionary keeps only the listed workspaces", (t) => {
  const db = createDb(t);
  if (!db) return;

  for (const ws of [WS, OTHER_WS]) {
    db.applySharedDictionaryPull(ws, {
      upserts: [entry(`${ws}-e1`, "Qdrant", { workspace_id: ws })],
      deletedIds: [],
      meta: meta([scope(null)]),
    });
    db.applySharedDictionaryHides(ws, {
      hidden: [{ entryId: `${ws}-e1`, updatedAt: "2026-10-20T10:00:00.000Z" }],
      unhidden: [],
    });
  }

  assert.deepEqual(db.pruneSharedDictionary([WS]), { changed: 3 });
  assert.equal(db.getSharedDictionary(WS).entries.length, 1);
  assert.deepEqual(db.getSharedDictionary(WS).hiddenIds, [`${WS}-e1`]);
  assert.deepEqual(db.getSharedDictionary(OTHER_WS), { entries: [], hiddenIds: [], meta: null });

  assert.deepEqual(db.pruneSharedDictionary([]), { changed: 3 });
  assert.deepEqual(db.getSharedDictionary(WS), { entries: [], hiddenIds: [], meta: null });
});

test("replaceSharedDictionaryHides reports what it changed, and hides are indexed", (t) => {
  const db = createDb(t);
  if (!db) return;

  const hide = { entryId: "e1", updatedAt: "2026-10-20T10:00:00.000Z" };
  assert.deepEqual(db.replaceSharedDictionaryHides(WS, [hide]), { changed: 1 });
  assert.deepEqual(db.replaceSharedDictionaryHides(WS, [hide]), { changed: 0 });
  assert.deepEqual(db.replaceSharedDictionaryHides(WS, []), { changed: 1 });

  const indexes = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all("shared_dictionary_hides")
    .map((row) => row.name);
  assert.ok(indexes.includes("idx_shared_dictionary_hides_workspace"));
});
