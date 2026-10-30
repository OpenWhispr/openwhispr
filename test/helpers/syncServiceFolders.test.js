// Folder half of the SyncService orchestration: real SyncService over the real
// cloudApi/FoldersService stack, a real DatabaseManager, and the fake cloud.
// Assertions are on the wire (cloud.log) as well as on the resulting rows.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: browserWindow,
  localStorage: browserLocalStorage,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");

installBrowserGlobals();

const loadSync = () => import("../../src/services/SyncService.ts");

async function setup(t, cloudConfig) {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return null;
  enableSync();
  const cloud = createFakeCloud(cloudConfig);
  browserWindow.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth();
  return { db, cloud };
}

async function newSyncService(t) {
  const { SyncService } = await loadSync();
  const service = new SyncService();
  if (t) t.after(() => stopSyncTimers(service));
  return service;
}

function folderByName(db, name) {
  return db.db.prepare("SELECT * FROM folders WHERE name = ?").get(name) ?? null;
}

function folderByClientId(db, clientFolderId) {
  return db.db.prepare("SELECT * FROM folders WHERE client_folder_id = ?").get(clientFolderId);
}

function allFolders(db) {
  return db.db.prepare("SELECT * FROM folders ORDER BY id").all();
}

function noteByClientId(db, clientNoteId) {
  return db.db.prepare("SELECT * FROM notes WHERE client_note_id = ?").get(clientNoteId);
}

// Deterministic timestamps come from SQL, never from a faked clock: SQLite's
// CURRENT_TIMESTAMP is second-granularity and the gate under test is textual.
function setFolderRow(db, id, columns) {
  const keys = Object.keys(columns);
  db.db
    .prepare(`UPDATE folders SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => columns[k]), id);
}

function shift(iso, hours) {
  return new Date(Date.parse(iso) + hours * 3600_000).toISOString();
}

test("a note in a folder with no cloud mapping pushes folder_id undefined, not the local row id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  // Folder creation fails, so nothing local ever gets a cloud_id.
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "folder push down" });
  const work = db.createFolder("Work").folder;
  const saved = db.saveNote("Spec", "body", "personal", null, null, work.id);

  await (await newSyncService(t)).syncAll(true);

  const [batch] = cloud.logFor("/api/notes/batch-create");
  assert.ok(batch, "the note must still be pushed even though the folder push failed");
  const sent = batch.body.notes[0];
  assert.equal(sent.client_note_id, saved.note.client_note_id);
  assert.equal(
    sent.folder_id,
    null,
    "an unmapped folder must null the reference, never leak the local integer id"
  );
  assert.notEqual(sent.folder_id, work.id);
  assert.equal(cloud.notes()[0].folder_id, null);
  assert.equal(db.getNote(saved.note.id).sync_status, "synced");
});

test("pulled notes map cloud folder ids back to local ids and park the row when the folder is unknown", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const warnings = t.mock.method(console, "warn", () => {});

  const work = cloud.seedFolder({
    client_folder_id: "cf-work",
    name: "Work",
    is_default: false,
    sort_order: 7,
  });
  cloud.seedNote({ client_note_id: "cn-mapped", title: "In Work", folder_id: work.id });
  cloud.seedNote({ client_note_id: "cn-orphan", title: "Nowhere", folder_id: "folder-9999" });

  await (await newSyncService(t)).syncAll(true);

  const localWork = folderByName(db, "Work");
  const personal = folderByName(db, "Personal");
  assert.ok(localWork, "the cloud-only folder must materialize locally");
  assert.notEqual(localWork.id, personal.id);

  assert.equal(
    noteByClientId(db, "cn-mapped").folder_id,
    localWork.id,
    "a known cloud folder must resolve through the cloud-to-local map"
  );
  // Filing the orphan anywhere would stick forever (the advanced cursor never
  // re-pulls the row), so the pull parks it until its folder arrives.
  assert.equal(
    noteByClientId(db, "cn-orphan"),
    undefined,
    "an unknown cloud folder must park the row, not file it locally"
  );
  assert.equal(
    browserLocalStorage.getItem("lastSyncedAt.notes"),
    null,
    "a parked pull must leave the note cursor unstamped so the row is re-seen"
  );
  assert.ok(
    warnings.mock.calls.some((c) => String(c.arguments[0]).includes("Parking note")),
    "the parked row must be named in the warnings"
  );
});

test("a fresh device adopts the cloud's default folders by name instead of pushing duplicates", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const cloudPersonal = cloud.seedFolder({
    client_folder_id: "cf-personal",
    name: "Personal",
    is_default: true,
    sort_order: 0,
  });
  const cloudMeetings = cloud.seedFolder({
    client_folder_id: "cf-meetings",
    name: "Meetings",
    is_default: true,
    sort_order: 1,
  });

  await (await newSyncService(t)).syncAll(true);

  const [batch] = cloud.logFor("/api/folders/batch-create");
  assert.deepEqual(
    batch.body.folders.map((f) => f.name),
    ["Videos"],
    "adopted defaults must be gone from the push, or the cloud forks a second Personal"
  );

  assert.equal(cloud.folders().length, 3);
  assert.equal(cloud.folders().filter((f) => f.name === "Personal").length, 1);
  assert.equal(allFolders(db).length, 3, "adoption must not add a local row either");

  const personal = folderByName(db, "Personal");
  assert.equal(personal.client_folder_id, "cf-personal");
  assert.equal(personal.cloud_id, cloudPersonal.id);
  assert.equal(personal.sync_status, "synced");
  assert.equal(folderByName(db, "Meetings").cloud_id, cloudMeetings.id);
});

test("pushPendingFolders sends name/client_folder_id/is_default/sort_order/parent_folder_id in row order and links each folder on ack", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  await (await newSyncService(t)).syncAll(true);

  const calls = cloud.logFor("/api/folders/batch-create");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");

  const sent = calls[0].body.folders;
  assert.deepEqual(
    sent.map((f) => f.name),
    ["Meetings", "Personal", "Videos"],
    "input order is what pairs created[i] with fresh[i] during identity adoption"
  );
  for (const folder of sent) {
    assert.deepEqual(Object.keys(folder).sort(), [
      "client_folder_id",
      "is_default",
      "name",
      "parent_folder_id",
      "sort_order",
    ]);
    assert.equal(folder.parent_folder_id, null, "a top-level folder states it has no parent");
    assert.equal(folder.is_default, true, "SQLite's 1 must be coerced to a boolean on the wire");
    assert.equal(typeof folder.sort_order, "number");
    assert.equal(typeof folder.client_folder_id, "string");
  }
  assert.deepEqual(
    sent.map((f) => f.sort_order),
    [1, 0, 2]
  );

  for (const local of allFolders(db)) {
    assert.equal(local.sync_status, "synced");
    const remote = cloud.folder(local.client_folder_id);
    assert.ok(remote, `cloud row missing for ${local.name}`);
    assert.equal(local.cloud_id, remote.id, "the ack's cloud id must be stored on the local row");
  }
});

test("a renamed linked folder PATCHes /api/folders/update instead of creating a second cloud folder", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const work = db.createFolder("Work").folder;
  await (await newSyncService(t)).syncAll(true);
  const cloudId = folderByName(db, "Work").cloud_id;
  assert.ok(cloudId);
  const folderCountAfterFirstPass = cloud.folders().length;

  db.renameFolder(work.id, "Work Renamed");
  // Future-dated so the pull in this same pass cannot stand in for the push ack.
  setFolderRow(db, work.id, { updated_at: "2027-01-01 00:00:00" });
  await (await newSyncService(t)).syncAll(true);

  const patches = cloud.logFor("/api/folders/update");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].method, "PATCH");
  assert.deepEqual(patches[0].body, {
    id: cloudId,
    name: "Work Renamed",
    sort_order: 3,
    parent_folder_id: null,
  });

  assert.equal(cloud.folder(cloudId).name, "Work Renamed");
  assert.equal(
    cloud.folders().length,
    folderCountAfterFirstPass,
    "a linked folder must never be re-created as a new cloud row"
  );
  assert.equal(folderByName(db, "Work Renamed").sync_status, "synced");
  assert.equal(cloud.logFor("/api/folders/batch-create").length, 1, "no second batch-create");
});

test("a failed folder PATCH leaves that folder pending and does not abort the rest of the loop", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const alpha = db.createFolder("Alpha").folder;
  const beta = db.createFolder("Beta").folder;
  await (await newSyncService(t)).syncAll(true);
  const alphaCloudId = folderByName(db, "Alpha").cloud_id;
  const betaCloudId = folderByName(db, "Beta").cloud_id;

  db.renameFolder(alpha.id, "Alpha Renamed");
  db.renameFolder(beta.id, "Beta Renamed");
  // Future-dated so the pull in this same pass cannot mask the push outcome.
  setFolderRow(db, alpha.id, { updated_at: "2027-01-01 00:00:00" });
  setFolderRow(db, beta.id, { updated_at: "2027-01-01 00:00:00" });

  cloud.failNext("PATCH /api/folders/update", { status: 500, error: "boom" });
  await (await newSyncService(t)).syncAll(true);

  const patches = cloud.logFor("/api/folders/update");
  assert.equal(
    patches.length,
    2,
    "the second folder must still be attempted after the first threw"
  );
  assert.deepEqual(patches[0].body, {
    id: alphaCloudId,
    name: "Alpha Renamed",
    sort_order: 3,
    parent_folder_id: null,
  });
  assert.deepEqual(patches[1].body, {
    id: betaCloudId,
    name: "Beta Renamed",
    sort_order: 4,
    parent_folder_id: null,
  });

  assert.equal(
    folderByName(db, "Alpha Renamed").sync_status,
    "pending",
    "a folder whose push failed must stay pending so the next pass retries it"
  );
  assert.equal(folderByName(db, "Beta Renamed").sync_status, "synced");
  assert.equal(cloud.folder(alphaCloudId).name, "Alpha");
  assert.equal(cloud.folder(betaCloudId).name, "Beta Renamed");
});

test("pushFolderDeletes sends the cloud id, hard-deletes on ack, and keeps the tombstone on failure", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const work = db.createFolder("Trash Me").folder;
  await (await newSyncService(t)).syncAll(true);
  const cloudId = folderByName(db, "Trash Me").cloud_id;

  db.deleteFolder(work.id);
  cloud.failNext("DELETE /api/folders/delete", { status: 503, error: "offline" });
  await (await newSyncService(t)).syncAll(true);

  const firstAttempt = cloud.logFor("/api/folders/delete");
  assert.equal(firstAttempt.length, 1);
  assert.equal(firstAttempt[0].method, "DELETE");
  assert.deepEqual(firstAttempt[0].body, { id: cloudId });

  const tombstone = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(work.id);
  assert.ok(tombstone, "a failed delete must keep the local tombstone for the next pass");
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.sync_status, "pending");
  assert.equal(cloud.folder(cloudId).deleted_at, null);

  await (await newSyncService(t)).syncAll(true);

  assert.equal(cloud.logFor("/api/folders/delete").length, 2, "the delete must be retried");
  assert.equal(
    db.db.prepare("SELECT * FROM folders WHERE id = ?").get(work.id),
    undefined,
    "an acked delete must drop the local row"
  );
  assert.ok(cloud.folder(cloudId).deleted_at, "the cloud row must be tombstoned");
});

test("pullFolders keeps a local folder whose same-day cloud copy is older and accepts a genuinely newer one", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  // "2026-07-27T11:00:00.000Z" > "2026-07-27 12:00:00" under a raw string
  // compare ('T' > ' '), so an unnormalized gate hands this to the stale cloud.
  const stale = cloud.seedFolder({
    client_folder_id: "cf-stale",
    name: "Stale Cloud Name",
    is_default: false,
    sort_order: 8,
    created_at: "2026-07-27T09:00:00.000Z",
    updated_at: "2026-07-27T11:00:00.000Z",
  });
  const fresher = cloud.seedFolder({
    client_folder_id: "cf-fresher",
    name: "Fresher Cloud Name",
    is_default: false,
    sort_order: 9,
    created_at: "2026-07-27T09:00:00.000Z",
    updated_at: "2026-07-27T13:00:00.000Z",
  });

  const keep = db.createFolder("Local Wins").folder;
  setFolderRow(db, keep.id, {
    client_folder_id: "cf-stale",
    cloud_id: stale.id,
    sync_status: "synced",
    updated_at: "2026-07-27 12:00:00",
  });
  const lose = db.createFolder("Local Loses").folder;
  setFolderRow(db, lose.id, {
    client_folder_id: "cf-fresher",
    cloud_id: fresher.id,
    sync_status: "synced",
    updated_at: "2026-07-27 12:00:00",
  });

  await (await newSyncService(t)).syncAll(true);

  assert.equal(
    folderByClientId(db, "cf-stale").name,
    "Local Wins",
    "an older cloud copy on the same UTC day must not overwrite the local folder"
  );
  assert.equal(
    folderByClientId(db, "cf-fresher").name,
    "Fresher Cloud Name",
    "a strictly newer cloud copy must still win, or the gate is just a no-op"
  );
});

test("a failed folder list leaves lastSyncedAt.folders unstamped so the next pass re-pulls from scratch", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud } = ctx;

  cloud.failWith("/api/folders/list", { status: 500, error: "list down" });
  await (await newSyncService(t)).syncAll(true);

  assert.equal(
    browserLocalStorage.getItem("lastSyncedAt.folders"),
    null,
    "stamping a failed pull would silently skip every folder change in that window"
  );

  cloud.clearFailures();
  await (await newSyncService(t)).syncAll(true);

  const lists = cloud.logFor("/api/folders/list");
  assert.equal(
    lists[lists.length - 1].path,
    "/api/folders/list",
    "with no stamp the recovery pass must ask for the full snapshot"
  );
  assert.ok(browserLocalStorage.getItem("lastSyncedAt.folders"), "a clean pull must stamp");
});

test("the folders cursor advances and the next pass only receives folders changed since the stamp", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  await (await newSyncService(t)).syncAll(true);
  const stamp = browserLocalStorage.getItem("lastSyncedAt.folders");
  assert.match(stamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

  cloud.seedFolder({
    client_folder_id: "cf-old",
    name: "Before The Stamp",
    is_default: false,
    sort_order: 20,
    created_at: shift(stamp, -2),
    updated_at: shift(stamp, -1),
  });
  cloud.seedFolder({
    client_folder_id: "cf-new",
    name: "After The Stamp",
    is_default: false,
    sort_order: 21,
    created_at: shift(stamp, -2),
    updated_at: shift(stamp, 1),
  });

  await (await newSyncService(t)).syncAll(true);

  const lists = cloud.logFor("/api/folders/list");
  assert.equal(
    lists[lists.length - 1].path,
    `/api/folders/list?since=${encodeURIComponent(stamp)}`,
    "the stored stamp must be sent as the since cursor"
  );
  assert.ok(folderByName(db, "After The Stamp"), "a folder newer than the cursor must arrive");
  assert.equal(
    folderByName(db, "Before The Stamp"),
    null,
    "re-delivering pre-cursor folders means the cursor was never sent"
  );
  assert.ok(
    Date.parse(browserLocalStorage.getItem("lastSyncedAt.folders")) >= Date.parse(stamp),
    "the cursor must advance"
  );
});

test("a folder tombstone arriving in the delta pull hard-deletes the local folder", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const shared = db.createFolder("Shared").folder;
  await (await newSyncService(t)).syncAll(true);
  const cloudId = folderByName(db, "Shared").cloud_id;
  const stamp = browserLocalStorage.getItem("lastSyncedAt.folders");

  // Another device deletes the folder. The server clock puts the tombstone past
  // the cursor; wall-clock would land in the same millisecond as the stamp.
  cloud.setClock(() => shift(stamp, 1));
  const deleted = await cloud.request({
    method: "DELETE",
    path: "/api/folders/delete",
    body: { id: cloudId },
  });
  assert.equal(deleted.success, true);

  await (await newSyncService(t)).syncAll(true);

  const lists = cloud.logFor("/api/folders/list");
  assert.equal(
    lists[lists.length - 1].path,
    `/api/folders/list?since=${encodeURIComponent(stamp)}`,
    "only the delta list carries tombstones; a snapshot pull would never see this delete"
  );
  assert.equal(
    db.db.prepare("SELECT * FROM folders WHERE id = ?").get(shared.id),
    undefined,
    "a remote delete must remove the local folder"
  );
});

test("a new parent and subfolder push in two rounds, the subfolder carrying its parent's cloud id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  // A linked folder whose PATCH 404s must not be retried by the second round.
  const gone = db.createFolder("Gone").folder;
  db.markFolderSynced(gone.id, "folder-missing");
  db.renameFolder(gone.id, "Gone Renamed");
  const parent = db.createFolder("Client A").folder;
  db.createFolder("Q1", null, parent.id);
  await (await newSyncService(t)).syncAll(true);

  assert.equal(cloud.logFor("/api/folders/update").length, 1);
  const batches = cloud.logFor("/api/folders/batch-create");
  assert.equal(batches.length, 2);
  assert.ok(!batches[0].body.folders.some((f) => f.name === "Q1"));
  const parentCloudId = folderByName(db, "Client A").cloud_id;
  assert.deepEqual(
    batches[1].body.folders.map((f) => [f.name, f.parent_folder_id]),
    [["Q1", parentCloudId]]
  );

  const child = folderByName(db, "Q1");
  assert.equal(child.sync_status, "synced");
  assert.equal(child.parent_folder_id, parent.id);
  assert.equal(cloud.folder(child.cloud_id).parent_folder_id, parentCloudId);
});

test("nesting and un-nesting a synced folder PATCHes the parent's cloud id, then null", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parent = db.createFolder("Client A").folder;
  const quarter = db.createFolder("Q1").folder;
  await (await newSyncService(t)).syncAll(true);
  const parentCloudId = folderByName(db, "Client A").cloud_id;
  const quarterCloudId = folderByName(db, "Q1").cloud_id;

  db.setFolderParent(quarter.id, parent.id);
  setFolderRow(db, quarter.id, { updated_at: "2027-01-01 00:00:00" });
  await (await newSyncService(t)).syncAll(true);
  assert.equal(cloud.logFor("/api/folders/update").at(-1).body.parent_folder_id, parentCloudId);
  assert.equal(cloud.folder(quarterCloudId).parent_folder_id, parentCloudId);

  db.setFolderParent(quarter.id, null);
  setFolderRow(db, quarter.id, { updated_at: "2027-01-02 00:00:00" });
  await (await newSyncService(t)).syncAll(true);
  assert.equal(cloud.logFor("/api/folders/update").at(-1).body.parent_folder_id, null);
  assert.equal(cloud.folder(quarterCloudId).parent_folder_id, null);
  assert.equal(folderByName(db, "Q1").parent_folder_id, null);
});

test("a pulled subfolder that arrives before its parent is linked once the page is stored", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parentRow = cloud.seedFolder({
    client_folder_id: "cf-client",
    name: "Client A",
    is_default: false,
    sort_order: 9,
  });
  cloud.seedFolder({
    client_folder_id: "cf-quarter",
    name: "Q1",
    is_default: false,
    sort_order: 8,
    parent_folder_id: parentRow.id,
  });
  await (await newSyncService(t)).syncAll(true);

  const localParent = folderByClientId(db, "cf-client");
  const localChild = folderByClientId(db, "cf-quarter");
  assert.equal(localChild.parent_folder_id, localParent.id);
  assert.equal(localChild.sync_status, "synced");
  assert.equal(
    cloud.logFor("/api/folders/update").length,
    0,
    "linking a pulled parent is not a local edit to push back"
  );
});

test("a subfolder the cloud refuses to nest goes top-level without stranding its batch", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parent = db.createFolder("Client A").folder;
  await (await newSyncService(t)).syncAll(true);
  const quarter = db.createFolder("Q1", null, parent.id).folder;
  db.createFolder("Sibling");

  const invalidParent = { status: 400, code: "invalid_parent_folder", error: "Invalid parent" };
  cloud.failNext("POST /api/folders/batch-create", invalidParent);
  cloud.failNext(
    (call) => call.path === "/api/folders/create" && call.body?.name === "Q1",
    invalidParent
  );
  await (await newSyncService(t)).syncAll(true);

  assert.equal(folderByName(db, "Sibling").sync_status, "synced");
  assert.equal(folderByName(db, "Q1").parent_folder_id, null);
  assert.equal(folderByName(db, "Q1").sync_status, "pending");

  await (await newSyncService(t)).syncAll(true);
  const synced = folderByName(db, "Q1");
  assert.equal(synced.id, quarter.id);
  assert.equal(synced.sync_status, "synced");
  assert.equal(cloud.folder(synced.cloud_id).parent_folder_id, null);
});

test("a pass with backup off leaves the nesting of personal folders alone", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parent = db.createFolder("Client A").folder;
  const quarter = db.createFolder("Q1").folder;
  const cloudParent = cloud.seedFolder({
    client_folder_id: parent.client_folder_id,
    name: "Client A",
    is_default: false,
    sort_order: 1,
  });
  const cloudQuarter = cloud.seedFolder({
    client_folder_id: quarter.client_folder_id,
    name: "Q1",
    is_default: false,
    sort_order: 2,
    parent_folder_id: cloudParent.id,
  });
  db.markFolderSynced(parent.id, cloudParent.id);
  db.markFolderSynced(quarter.id, cloudQuarter.id);

  browserLocalStorage.removeItem("cloudBackupEnabled");
  await (await newSyncService(t)).syncAll(true);

  assert.ok(cloud.logFor("/api/folders/list").length > 0, "the team-only pass pulled folders");
  assert.equal(folderByName(db, "Q1").parent_folder_id, null);
});

test("a subfolder waits while its parent's PATCH fails and keeps its nesting", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parent = db.createFolder("Client A").folder;
  const quarter = db.createFolder("Q1", null, parent.id).folder;
  await (await newSyncService(t)).syncAll(true);
  const parentCloudId = folderByName(db, "Client A").cloud_id;
  const quarterCloudId = folderByName(db, "Q1").cloud_id;

  db.renameFolder(parent.id, "Client B");
  db.renameFolder(quarter.id, "Q2");
  setFolderRow(db, parent.id, { updated_at: "2027-01-01 00:00:00" });
  setFolderRow(db, quarter.id, { updated_at: "2027-01-01 00:00:00" });
  cloud.failNext((call) => call.path === "/api/folders/update" && call.body?.id === parentCloudId, {
    status: 500,
    error: "boom",
  });
  await (await newSyncService(t)).syncAll(true);

  assert.deepEqual(
    cloud.logFor("/api/folders/update").map((call) => call.body.id),
    [parentCloudId],
    "the subfolder is not sent under a parent whose push failed"
  );
  const waiting = folderByName(db, "Q2");
  assert.equal(waiting.sync_status, "pending");
  assert.equal(waiting.parent_folder_id, parent.id);

  await (await newSyncService(t)).syncAll(true);
  assert.deepEqual(
    cloud.logFor("/api/folders/update").map((call) => call.body.id),
    [parentCloudId, parentCloudId, quarterCloudId]
  );
  assert.equal(folderByName(db, "Q2").sync_status, "synced");
  assert.equal(cloud.folder(quarterCloudId).name, "Q2");
  assert.equal(cloud.folder(quarterCloudId).parent_folder_id, parentCloudId);
});

test("a subfolder PATCH the cloud refuses to nest goes top-level and pushes that next pass", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parent = db.createFolder("Client A").folder;
  const quarter = db.createFolder("Q1", null, parent.id).folder;
  await (await newSyncService(t)).syncAll(true);
  const quarterCloudId = folderByName(db, "Q1").cloud_id;

  db.renameFolder(quarter.id, "Q2");
  setFolderRow(db, quarter.id, { updated_at: "2027-01-01 00:00:00" });
  cloud.failNext("PATCH /api/folders/update", {
    status: 400,
    code: "invalid_parent_folder",
    error: "Invalid parent",
  });
  await (await newSyncService(t)).syncAll(true);

  const unnested = folderByName(db, "Q2");
  assert.equal(unnested.parent_folder_id, null);
  assert.equal(unnested.sync_status, "pending");

  await (await newSyncService(t)).syncAll(true);
  assert.equal(cloud.logFor("/api/folders/update").at(-1).body.parent_folder_id, null);
  assert.equal(folderByName(db, "Q2").sync_status, "synced");
  assert.equal(cloud.folder(quarterCloudId).parent_folder_id, null);
});

test("a subfolder waits for its parent's un-nest before nesting under it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const archive = db.createFolder("Archive").folder;
  const projects = db.createFolder("Projects", null, archive.id).folder;
  const acme = db.createFolder("Acme").folder;
  await (await newSyncService(t)).pushPendingFolders();

  db.setFolderParent(projects.id, null);
  db.setFolderParent(acme.id, projects.id);
  await (await newSyncService(t)).pushPendingFolders();

  assert.deepEqual(
    cloud.logFor("/api/folders/update").map((call) => [call.body.name, call.body.parent_folder_id]),
    [
      ["Projects", null],
      ["Acme", folderByName(db, "Projects").cloud_id],
    ]
  );
  assert.equal(folderByName(db, "Acme").parent_folder_id, projects.id);
});

// A synced team folder "Roadmap" holding a synced note, moved to the private
// space and nested under a new private folder "Clients" before it syncs again.
function nestLeavingTeamFolder(db, cloud) {
  db.setActiveAccountId("test-account");
  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, cloud_space_id) VALUES (?, 'team', ?, 1, ?)"
    )
    .run("team-leaving", "Growth", "cloud-growth").lastInsertRowid;
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team, "test-account");
  const roadmap = db.createFolder("Roadmap", team).folder;
  const cloudRoadmap = cloud.seedFolder({
    client_folder_id: roadmap.client_folder_id,
    name: "Roadmap",
    is_default: false,
    sort_order: 1,
  });
  db.markFolderSynced(roadmap.id, cloudRoadmap.id);
  const plan = db.saveNote("Plan", "body", "personal", null, null, roadmap.id, team).note;
  const cloudPlan = cloud.seedNote({ client_note_id: plan.client_note_id, title: "Plan" });
  db.markNoteSynced(plan.id, cloudPlan.id);
  db.moveFolderToSpace(roadmap.id, db.getPrivateSpaceId());
  // The move comes after the seeded cloud note, or the cloud rejects it as stale.
  db.db.prepare("UPDATE notes SET updated_at = '2027-01-01 00:00:00'").run();
  const clients = db.createFolder("Clients").folder;
  db.setFolderParent(roadmap.id, clients.id);
  browserLocalStorage.setItem("teamSpacesCapability", "true");
  return { cloudRoadmap, cloudPlan, clients };
}

test("a folder leaving a team retracts at once and nests once its new parent exists", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const { cloudRoadmap, clients } = nestLeavingTeamFolder(db, cloud);

  await (await newSyncService(t)).pushPendingFolders();
  assert.deepEqual(
    cloud.logFor("/api/folders/update").map((call) => [call.body.id, call.body.parent_folder_id]),
    [[cloudRoadmap.id, null]]
  );
  const roadmap = folderByName(db, "Roadmap");
  assert.equal(roadmap.sync_status, "pending");
  assert.equal(roadmap.left_team, 0);

  await (await newSyncService(t)).syncAll(true);
  assert.equal(
    cloud.folder(cloudRoadmap.id).parent_folder_id,
    folderByName(db, "Clients").cloud_id
  );
  assert.equal(folderByName(db, "Roadmap").parent_folder_id, clients.id);
});

test("a folder leaving a team pushes its retraction under a private parent that never syncs", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const { cloudRoadmap, cloudPlan, clients } = nestLeavingTeamFolder(db, cloud);

  browserLocalStorage.removeItem("cloudBackupEnabled");
  const service = await newSyncService(t);
  await service.pushPendingFolders(true);
  await service.pushPendingNotes(true);
  await service.pushPendingFolders(true);
  assert.deepEqual(
    cloud.logFor("/api/folders/update").map((call) => [call.body.id, call.body.parent_folder_id]),
    [[cloudRoadmap.id, null]],
    "the retraction is sent once"
  );
  assert.deepEqual(
    cloud.logFor("/api/notes/update").map((call) => call.body.id),
    [cloudPlan.id],
    "the folder's note retracts too"
  );
  const plan = noteByClientId(db, cloudPlan.client_note_id);
  assert.equal(plan.sync_status, "synced");
  assert.equal(plan.left_team, 0);
  await (await newSyncService(t)).syncAll(true);
  assert.equal(folderByName(db, "Roadmap").parent_folder_id, clients.id);

  // Once backup is on, the parent is created and the nesting follows, even
  // when a pull runs before that create succeeds.
  browserLocalStorage.setItem("cloudBackupEnabled", "true");
  cloud.failNext("POST /api/folders/batch-create", { status: 500, error: "down" });
  await (await newSyncService(t)).syncAll(true);
  assert.equal(folderByName(db, "Roadmap").parent_folder_id, clients.id);
  await (await newSyncService(t)).syncAll(true);
  assert.equal(
    cloud.folder(cloudRoadmap.id).parent_folder_id,
    folderByName(db, "Clients").cloud_id
  );
  assert.equal(folderByName(db, "Roadmap").parent_folder_id, clients.id);
});

// A synced team folder "Roadmap" and its synced subfolder "Q1", each holding a
// synced note, moved to the private space together.
function carryTeamSubfolderOut(db, cloud) {
  db.setActiveAccountId("test-account");
  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, cloud_space_id) VALUES (?, 'team', ?, 1, ?)"
    )
    .run("team-carried", "Growth", "cloud-growth").lastInsertRowid;
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team, "test-account");
  const seed = (name, parent) => {
    const folder = db.createFolder(name, team, parent?.folder.id).folder;
    const cloudFolder = cloud.seedFolder({
      client_folder_id: folder.client_folder_id,
      name,
      is_default: false,
      sort_order: 1,
      parent_folder_id: parent?.cloudFolder.id,
    });
    db.markFolderSynced(folder.id, cloudFolder.id);
    const note = db.saveNote(name, "body", "personal", null, null, folder.id, team).note;
    const cloudNote = cloud.seedNote({ client_note_id: note.client_note_id, title: name });
    db.markNoteSynced(note.id, cloudNote.id);
    return { folder, cloudFolder, cloudNote };
  };
  const roadmap = seed("Roadmap");
  const quarter = seed("Q1", roadmap);
  assert.ok(db.moveFolderToSpace(roadmap.folder.id, db.getPrivateSpaceId()).success);
  // The move comes after the seeded cloud notes, or the cloud rejects it as stale.
  db.db.prepare("UPDATE notes SET updated_at = '2027-01-01 00:00:00'").run();
  browserLocalStorage.setItem("teamSpacesCapability", "true");
  return { roadmap, quarter };
}

function assertCarriedRetraction(db, cloud, { roadmap, quarter }) {
  assert.deepEqual(
    cloud
      .logFor("/api/folders/update")
      .map((call) => [call.body.id, call.body.space_id, call.body.parent_folder_id]),
    [
      [quarter.cloudFolder.id, null, null],
      [roadmap.cloudFolder.id, null, null],
    ]
  );
  assert.deepEqual(
    cloud
      .logFor("/api/notes/update")
      .map((call) => [call.body.id, call.body.space_id, call.body.folder_id])
      .sort(),
    [
      [quarter.cloudNote.id, null, quarter.cloudFolder.id],
      [roadmap.cloudNote.id, null, roadmap.cloudFolder.id],
    ].sort()
  );
  const q1 = folderByName(db, "Q1");
  assert.equal(q1.parent_folder_id, roadmap.folder.id, "the pull keeps the unpushed nesting");
  assert.equal(q1.sync_status, "pending");
  assert.equal(folderByName(db, "Roadmap").sync_status, "synced");
  assert.equal(db.db.prepare("SELECT 1 FROM folders WHERE left_team = 1").get(), undefined);
  assert.equal(db.db.prepare("SELECT 1 FROM notes WHERE left_team = 1").get(), undefined);
}

test("a subfolder carried out of a team retracts with its parent, then nests under it", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const carried = carryTeamSubfolderOut(db, cloud);

  const service = await newSyncService(t);
  await service.syncFolders();
  await service.syncNotes();
  assertCarriedRetraction(db, cloud, carried);

  await (await newSyncService(t)).syncAll(true);
  const { roadmap, quarter } = carried;
  assert.equal(cloud.folder(quarter.cloudFolder.id).parent_folder_id, roadmap.cloudFolder.id);
  assert.equal(folderByName(db, "Q1").sync_status, "synced");
  assert.equal(folderByName(db, "Q1").parent_folder_id, roadmap.folder.id);
});

test("without backup, a carried subfolder retracts with its parent and nests once backup is on", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const carried = carryTeamSubfolderOut(db, cloud);

  browserLocalStorage.removeItem("cloudBackupEnabled");
  const service = await newSyncService(t);
  for (let pass = 0; pass < 2; pass++) {
    await service.syncFolders(true);
    await service.syncNotes(true);
  }
  assertCarriedRetraction(db, cloud, carried);

  browserLocalStorage.setItem("cloudBackupEnabled", "true");
  await (await newSyncService(t)).syncAll(true);
  const { roadmap, quarter } = carried;
  assert.equal(cloud.folder(quarter.cloudFolder.id).parent_folder_id, roadmap.cloudFolder.id);
  assert.equal(folderByName(db, "Q1").sync_status, "synced");
});
