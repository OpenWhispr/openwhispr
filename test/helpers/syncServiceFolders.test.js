// Folder half of the SyncService orchestration: real SyncService over the real
// cloudApi/FoldersService stack, a real DatabaseManager, and the fake cloud.
// Assertions are on the wire (cloud.log) as well as on the resulting rows.
// Team folders sync independently of Backup; personal folders follow consent.

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
const { TEAM_ACCOUNT, TEAM_SPACE, joinTeamSpace } = require("./harness/teamSpace.js");
const { deferred } = require("./harness/deferred.js");

installBrowserGlobals();

const loadSync = () => import("../../src/services/SyncService.ts");

async function setup(t, cloudConfig) {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return null;
  enableSync();
  const cloud = createFakeCloud(cloudConfig);
  browserWindow.electronAPI = createElectronApi(db, { cloud });
  const team = joinTeamSpace(db, cloud);
  await establishValidatedAuth();
  return { db, cloud, team };
}

// Personal folders only, no teamspace: the subfolder tests nest Private folders,
// and set up any teamspace they need themselves. The database is scoped to the
// harness account before the sign-in binds, as main scopes it.
async function setupPersonal(t, cloudConfig) {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return null;
  enableSync();
  db.setActiveAccountId(TEAM_ACCOUNT);
  const cloud = createFakeCloud(cloudConfig);
  browserWindow.electronAPI = createElectronApi(db, { cloud });
  await establishValidatedAuth(TEAM_ACCOUNT);
  // These scenarios start after the one-time restored-backup cursor repair.
  browserLocalStorage.setItem(`syncCursors.privateBackup:${TEAM_ACCOUNT}`, "1");
  return { db, cloud };
}

// A Private folder with no cloud id holds its notes while Backup is on, for up
// to 30 minutes; this puts its wait that far behind.
const backdateFolderWait = (clientFolderId, minutes) =>
  browserLocalStorage.setItem(
    "folderWaitStartedAt",
    JSON.stringify({ [clientFolderId]: Date.now() - minutes * 60_000 })
  );

// The scope every teamspace folder push carries.
const TEAM_SCOPE = { workspace_id: TEAM_SPACE.workspace_id, space_id: TEAM_SPACE.id };

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

for (const [pauseAt, sameSecond] of [
  ["folder response", false],
  ["parent application", false],
  ["folder response", true],
  ["parent application", true],
]) {
  test(`a reparent pushed during ${pauseAt} survives a ${sameSecond ? "same-second" : "stale"} pull and a later rename`, async (t) => {
    const ctx = await setupPersonal(t);
    if (!ctx) return;
    const { db, cloud } = ctx;
    const service = await newSyncService(t);
    const parent = db.createFolder("Parent").folder;
    const child = db.createFolder("Child").folder;
    cloud.setClock(() => "2027-01-01T00:00:00.000Z");
    await service.pushPendingFolders();
    const cloudChildId = folderByClientId(db, child.client_folder_id).cloud_id;
    const cloudParentId = folderByClientId(db, parent.client_folder_id).cloud_id;
    if (pauseAt === "parent application") {
      setFolderRow(db, child.id, { updated_at: "2026-01-01 00:00:00" });
    }
    await service.backfillFolderParents(false);
    const paused = deferred();
    const resume = deferred();
    t.after(() => resume.resolve());
    const api = browserWindow.electronAPI;
    if (pauseAt === "folder response") {
      const request = api.cloudApiRequest;
      t.mock.method(api, "cloudApiRequest", async (options) => {
        const response = await request(options);
        if (options.path.startsWith("/api/folders/list")) {
          paused.resolve();
          await resume.promise;
        }
        return response;
      });
    } else {
      const applyParents = api.applyCloudFolderParents;
      t.mock.method(api, "applyCloudFolderParents", async (links) => {
        paused.resolve();
        await resume.promise;
        return applyParents(links);
      });
    }

    const pull = service.pullFolders();
    await paused.promise;
    assert.equal(db.setFolderParent(child.id, parent.id).success, true);
    setFolderRow(db, child.id, {
      updated_at: sameSecond ? "2027-01-01 00:00:00" : "2027-01-01 00:00:01",
    });
    cloud.setClock(() => "2027-01-01T00:00:01.000Z");
    await service.pushEntity("folder", child.id);
    assert.equal(folderByClientId(db, child.client_folder_id).sync_status, "synced");
    assert.equal(cloud.folder(cloudChildId).parent_folder_id, cloudParentId);

    resume.resolve();
    assert.equal(await pull, true);
    assert.equal(folderByClientId(db, child.client_folder_id).parent_folder_id, parent.id);
    assert.equal(db.renameFolder(child.id, "Renamed child").success, true);
    await service.pushEntity("folder", child.id);
    assert.equal(cloud.folder(cloudChildId).parent_folder_id, cloudParentId);
  });
}

test("a pulled subfolder still links when its parent's failed upsert is retried", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const parent = cloud.seedFolder({ client_folder_id: "remote-parent", name: "Parent" });
  cloud.seedFolder({
    client_folder_id: "remote-child",
    name: "Child",
    parent_folder_id: parent.id,
  });
  const upsert = browserWindow.electronAPI.upsertFolderFromCloud;
  let failParent = true;
  t.mock.method(console, "error", () => {});
  t.mock.method(browserWindow.electronAPI, "upsertFolderFromCloud", async (folder, spaceId) => {
    if (folder.id === parent.id && failParent) throw new Error("temporary write failure");
    return upsert(folder, spaceId);
  });

  assert.equal(await service.pullFolders(), false);
  assert.equal(folderByName(db, "Child").parent_folder_id, null);
  failParent = false;
  assert.equal(await service.pullFolders(), true);
  assert.equal(folderByName(db, "Child").parent_folder_id, folderByName(db, "Parent").id);
});

test("a note in a folder with no cloud mapping pushes folder_id undefined, not the local row id", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, team } = ctx;

  // Folder creation fails, so nothing local ever gets a cloud_id.
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "folder push down" });
  const work = db.createFolder("Work", team.id).folder;
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
  assert.ok(localWork, "the cloud-only folder must materialize locally");
  assert.equal(localWork.space_id, ctx.team.id);

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

test("private default folders follow Backup consent and reuse an existing cloud default", async (t) => {
  for (const backup of [true, false]) {
    await t.test(backup ? "Backup on" : "Backup off", async (st) => {
      const ctx = await setup(st);
      if (!ctx) return;
      const { db, cloud } = ctx;
      browserLocalStorage.setItem("cloudBackupEnabled", String(backup));
      const remote = cloud.seedFolder({
        client_folder_id: "cf-personal",
        name: "Personal",
        is_default: true,
        sort_order: 0,
        space_id: null,
        workspace_id: null,
      });
      db.saveNote("Private", "body");
      const privateSpaceId = db.getPrivateSpaceId();
      const project = db.createFolder("Private projects", privateSpaceId).folder;
      const before = allFolders(db).filter((folder) => folder.space_id === privateSpaceId);
      assert.ok(before.some((folder) => folder.name === "Personal" && folder.is_default));

      await (await newSyncService(st)).syncAll(true);

      const after = allFolders(db).filter((folder) => folder.space_id === privateSpaceId);
      if (backup) {
        assert.equal(after.find((folder) => folder.name === "Personal").cloud_id, remote.id);
        assert.equal(cloud.folders().filter((folder) => folder.name === "Personal").length, 1);
        assert.equal(after.find((folder) => folder.name === "Personal").sync_status, "synced");
        const uploaded = after.find((folder) => folder.id === project.id);
        assert.ok(uploaded.cloud_id);
        assert.equal(uploaded.sync_status, "synced");
      } else {
        assert.equal(cloud.logFor("/api/folders/batch-create").length, 0);
        assert.equal(cloud.logFor("/api/folders/create").length, 0);
        assert.equal(cloud.folders().length, 1);
        assert.deepEqual(after, before);
      }
    });
  }
});

test("pushPendingFolders sends name/client_folder_id/is_default/sort_order/parent_folder_id in row order and links each folder on ack", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, team } = ctx;
  const created = ["Videos", "Meetings", "Personal"].map((name) => db.createFolder(name, team.id));
  setFolderRow(db, created[1].folder.id, { is_default: 1 });

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
      "space_id",
      "workspace_id",
    ]);
    assert.equal(folder.parent_folder_id, null, "a top-level folder states it has no parent");
    assert.equal(folder.space_id, TEAM_SPACE.id);
    assert.equal(folder.workspace_id, TEAM_SPACE.workspace_id);
    assert.equal(typeof folder.is_default, "boolean");
    assert.equal(typeof folder.sort_order, "number");
    assert.equal(typeof folder.client_folder_id, "string");
  }
  assert.deepEqual(
    sent.map((f) => f.is_default),
    [true, false, false],
    "SQLite's 1 and 0 must be coerced to booleans on the wire"
  );
  assert.deepEqual(
    sent.map((f) => f.sort_order),
    [2, 3, 1]
  );

  for (const local of allFolders(db).filter((folder) => folder.space_id === team.id)) {
    assert.equal(local.sync_status, "synced");
    const remote = cloud.folder(local.client_folder_id);
    assert.ok(remote, `cloud row missing for ${local.name}`);
    assert.equal(local.cloud_id, remote.id, "the ack's cloud id must be stored on the local row");
  }
});

test("a renamed linked folder PATCHes /api/folders/update instead of creating a second cloud folder", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { db, cloud, team } = ctx;

  const work = db.createFolder("Work", team.id).folder;
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
    sort_order: 1,
    parent_folder_id: null,
    ...TEAM_SCOPE,
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
  const { db, cloud, team } = ctx;

  const alpha = db.createFolder("Alpha", team.id).folder;
  const beta = db.createFolder("Beta", team.id).folder;
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
    sort_order: 1,
    parent_folder_id: null,
    ...TEAM_SCOPE,
  });
  assert.deepEqual(patches[1].body, {
    id: betaCloudId,
    name: "Beta Renamed",
    sort_order: 2,
    parent_folder_id: null,
    ...TEAM_SCOPE,
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
  const { db, cloud, team } = ctx;

  const work = db.createFolder("Trash Me", team.id).folder;
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

  const keep = db.createFolder("Local Wins", ctx.team.id).folder;
  setFolderRow(db, keep.id, {
    client_folder_id: "cf-stale",
    cloud_id: stale.id,
    sync_status: "synced",
    updated_at: "2026-07-27 12:00:00",
  });
  const lose = db.createFolder("Local Loses", ctx.team.id).folder;
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

test("a failed folder list retains the initial recovery cursor so the next pass replays history", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { cloud } = ctx;

  cloud.failWith("/api/folders/list", { status: 500, error: "list down" });
  await (await newSyncService(t)).syncAll(true);

  assert.equal(
    browserLocalStorage.getItem("lastSyncedAt.folders"),
    "1970-01-01T00:00:00.000Z",
    "stamping a failed pull would silently skip every folder change in that window"
  );

  cloud.clearFailures();
  await (await newSyncService(t)).syncAll(true);

  const lists = cloud.logFor("/api/folders/list");
  assert.equal(
    lists[lists.length - 1].path,
    "/api/folders/list?since=1970-01-01T00%3A00%3A00.000Z&scope=all",
    "the recovery pass must include history and its tombstones"
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
    `/api/folders/list?since=${encodeURIComponent(stamp)}&scope=all`,
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
  const { db, cloud, team } = ctx;

  const shared = db.createFolder("Shared", team.id).folder;
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
    `/api/folders/list?since=${encodeURIComponent(stamp)}&scope=all`,
    "only the delta list carries tombstones; a snapshot pull would never see this delete"
  );
  assert.equal(
    db.db.prepare("SELECT * FROM folders WHERE id = ?").get(shared.id),
    undefined,
    "a remote delete must remove the local folder"
  );
});

// A new Private "Ideas" whose create the API answers with the account's own
// "Ideas" (lib/folders-service.ts adoptExistingFolder), under the client key
// `holderKey` already holds here. The pull never sees that cloud row again
// (its cursor is past it), so only the push can link the folder.
async function pushConvergedIdeas(t, placeHolder) {
  const ctx = await setup(t);
  if (!ctx) return null;
  const { db, cloud } = ctx;
  browserLocalStorage.setItem("cloudBackupEnabled", "true");
  const remote = cloud.seedFolder({
    client_folder_id: "cf-ideas",
    name: "Ideas",
    is_default: false,
    sort_order: 4,
    space_id: null,
    workspace_id: null,
  });
  browserLocalStorage.setItem("lastSyncedAt.accountId", TEAM_ACCOUNT);
  browserLocalStorage.setItem(`syncCursors.privateBackup:${TEAM_ACCOUNT}`, "1");
  browserLocalStorage.setItem("lastSyncedAt.folders", remote.updated_at);
  placeHolder(db, remote);
  const ideas = db.createFolder("Ideas", db.getPrivateSpaceId()).folder;
  const saved = db.saveNote("Plan", "body", "personal", null, null, ideas.id);

  const request = browserWindow.electronAPI.cloudApiRequest;
  browserWindow.electronAPI.cloudApiRequest = async (opts) => {
    const converges = (input) => input?.name === "Ideas" && !input.space_id;
    if (opts?.path === "/api/folders/batch-create" && opts.body?.folders?.every(converges)) {
      cloud.log.push({ method: "POST", path: opts.path, body: structuredClone(opts.body) });
      return { success: true, data: { created: opts.body.folders.map(() => remote) } };
    }
    return request(opts);
  };

  await (await newSyncService(t)).syncAll(true);
  return { db, cloud, remote, ideas, saved };
}

// The signed-out stand-in's copy of the folder this account backed up before the split.
function placeStandInIdeas(db, remote) {
  const standInId = db._standInPrivateSpaceId() ?? db._insertPrivateSpace(null, null);
  db.db
    .prepare(
      `INSERT INTO folders (name, is_default, sort_order, client_folder_id, cloud_id, sync_status, space_id)
       VALUES ('Ideas', 0, 4, 'cf-ideas', ?, 'synced', ?)`
    )
    .run(remote.id, standInId);
}

test("a Private folder whose converged key a folder out of view holds links under its own key", async (t) => {
  const result = await pushConvergedIdeas(t, placeStandInIdeas);
  if (!result) return;
  const { db, cloud, remote, ideas, saved } = result;

  const linked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(ideas.id);
  assert.equal(linked.cloud_id, remote.id);
  assert.equal(linked.client_folder_id, ideas.client_folder_id, "it keeps its own key");
  assert.equal(linked.sync_status, "synced");
  const uploaded = cloud.notes().find((note) => note.client_note_id === saved.note.client_note_id);
  assert.ok(uploaded, "the note in it uploads");
  assert.equal(uploaded.folder_id, remote.id);
});

test("a Private folder whose converged key a folder in view holds stays unlinked", async (t) => {
  const result = await pushConvergedIdeas(t, (db, remote) => {
    // The account's "Ideas" in another workspace's Private, already linked.
    const otherPrivate = db._insertPrivateSpace(TEAM_ACCOUNT, "workspace-2");
    const holder = db.createFolder("Ideas", otherPrivate).folder;
    setFolderRow(db, holder.id, {
      client_folder_id: "cf-ideas",
      cloud_id: remote.id,
      sync_status: "synced",
    });
  });
  if (!result) return;
  const { db, ideas } = result;

  const unlinked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(ideas.id);
  assert.equal(unlinked.cloud_id, null, "two visible folders never stand for one cloud folder");
  assert.equal(unlinked.sync_status, "pending");
});

test("a Private folder whose converged key an unlinked folder in view holds stays unlinked", async (t) => {
  const result = await pushConvergedIdeas(t, (db) => {
    // Linked to nothing yet, so only the key shows it stands for that cloud folder.
    const otherPrivate = db._insertPrivateSpace(TEAM_ACCOUNT, "workspace-2");
    const holder = db.createFolder("Old ideas", otherPrivate).folder;
    setFolderRow(db, holder.id, { client_folder_id: "cf-ideas", sync_status: "synced" });
  });
  if (!result) return;
  const { db, ideas } = result;

  const unlinked = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(ideas.id);
  assert.equal(unlinked.cloud_id, null);
  assert.equal(unlinked.sync_status, "pending");
});

test("a linked folder whose key the stand-in holds keeps pulling its cloud changes", async (t) => {
  for (const change of [{ sort_order: 9 }, { name: "Ideas renamed" }]) {
    await t.test(Object.keys(change)[0], async (st) => {
      const result = await pushConvergedIdeas(st, placeStandInIdeas);
      if (!result) return;
      const { db, cloud, remote, ideas } = result;
      const standInCopy = () => folderByClientId(db, "cf-ideas");
      const standInBefore = standInCopy();
      const cursorBefore = browserLocalStorage.getItem("lastSyncedAt.folders");

      // Another device changes the folder after this device's cursor.
      cloud.setClock(() => shift(new Date().toISOString(), 1));
      const patched = await cloud.request({
        method: "PATCH",
        path: "/api/folders/update",
        body: { id: remote.id, ...change },
      });
      assert.equal(patched.success, true);
      await (await newSyncService(st)).syncAll(true);

      assert.notEqual(
        browserLocalStorage.getItem("lastSyncedAt.folders"),
        cursorBefore,
        "the pull settles, so the folders cursor moves on"
      );
      const own = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(ideas.id);
      assert.equal(own.cloud_id, remote.id);
      for (const [field, value] of Object.entries(change)) assert.equal(own[field], value);
      assert.deepEqual(standInCopy(), standInBefore, "the stand-in's copy is never taken over");
    });
  }
});

test("a new parent and subfolder push in two rounds, the subfolder carrying its parent's cloud id", async (t) => {
  const ctx = await setupPersonal(t);
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
  const ctx = await setupPersonal(t);
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
  const ctx = await setupPersonal(t);
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
  const ctx = await setupPersonal(t);
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

test("a folder name taken mid-batch doesn't keep the folders after it from the cloud", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  await (await newSyncService(t)).syncAll(true);
  db.createFolder("Acme");
  db.createFolder("Beta");
  const taken = { status: 409, code: "folder_name_taken", error: "Folder name already taken" };
  cloud.failNext("POST /api/folders/batch-create", taken);
  cloud.failNext(
    (call) => call.path === "/api/folders/create" && call.body?.name === "Acme",
    taken
  );
  await (await newSyncService(t)).syncAll(true);

  assert.equal(folderByName(db, "Acme").sync_status, "pending");
  assert.equal(folderByName(db, "Beta").sync_status, "synced");
});

test("a pass with backup off leaves the nesting of personal folders alone", async (t) => {
  const ctx = await setupPersonal(t);
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
  const ctx = await setupPersonal(t);
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

test("a note in a new subfolder waits with it for the parent's PATCH", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;

  const parent = db.createFolder("Client A").folder;
  await (await newSyncService(t)).syncAll(true);
  db.renameFolder(parent.id, "Client B");
  setFolderRow(db, parent.id, { updated_at: "2027-01-01 00:00:00" });
  const quarter = db.createFolder("Q1", null, parent.id).folder;
  const plan = db.saveNote("Plan", "body", "personal", null, null, quarter.id).note;
  const cloudPlan = () => cloud.notes().find((n) => n.client_note_id === plan.client_note_id);
  cloud.failNext("PATCH /api/folders/update", {
    status: 409,
    code: "folder_name_taken",
    error: "Folder name already taken",
  });
  await (await newSyncService(t)).syncAll(true);

  assert.equal(cloudPlan(), undefined, "the note doesn't upload without its folder");
  assert.equal(db.getNote(plan.id).sync_status, "pending");

  await (await newSyncService(t)).syncAll(true);
  assert.equal(cloudPlan().folder_id, folderByName(db, "Q1").cloud_id);
});

test("a subfolder PATCH the cloud refuses to nest goes top-level and pushes that next pass", async (t) => {
  const ctx = await setupPersonal(t);
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
  const ctx = await setupPersonal(t);
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

// D31 refuses moving a synced team folder to Private, so these tests start from
// the state an older build's move left: the folder (and its subfolders) and its
// owner's notes in Private, still owing their scope retraction; a teammate's
// note stays in the team, at its top level. As that build's moveFolderToSpace.
function leaveTeamAsOlderBuild(db, folderId, privateSpaceId) {
  const folderIds = [
    folderId,
    ...db.db
      .prepare("SELECT id FROM folders WHERE parent_folder_id = ?")
      .all(folderId)
      .map((row) => row.id),
  ];
  const inFolders = `IN (${folderIds.map(() => "?").join(", ")})`;
  db.db
    .prepare(
      `UPDATE notes SET folder_id = NULL, sync_status = 'pending', updated_at = datetime('now')
       WHERE folder_id ${inFolders} AND deleted_at IS NULL AND owner_user_id <> ?`
    )
    .run(...folderIds, db.activeAccountId);
  db.db
    .prepare(
      `UPDATE folders SET space_id = ?, sync_status = 'pending', updated_at = datetime('now'),
         left_team = (CASE WHEN cloud_id IS NOT NULL THEN 1 ELSE 0 END),
         parent_folder_id = (CASE WHEN id = ? THEN NULL ELSE parent_folder_id END)
       WHERE id ${inFolders}`
    )
    .run(privateSpaceId, folderId, ...folderIds);
  db.db
    .prepare(
      `UPDATE notes SET space_id = ?, sync_status = 'pending', updated_at = datetime('now'),
         left_team = (CASE WHEN cloud_id IS NOT NULL THEN 1 ELSE 0 END)
       WHERE folder_id ${inFolders} AND deleted_at IS NULL`
    )
    .run(privateSpaceId, ...folderIds);
}

// A synced team folder "Roadmap" holding a synced note, moved to the private
// space and nested under a new private folder "Clients" before it syncs again.
function nestLeavingTeamFolder(db, cloud) {
  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, cloud_space_id) VALUES (?, 'team', ?, 1, ?)"
    )
    .run("team-leaving", "Growth", "cloud-growth").lastInsertRowid;
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team, db.activeAccountId);
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
  leaveTeamAsOlderBuild(db, roadmap.id, db.getPrivateSpaceId());
  // The move comes after the seeded cloud note, or the cloud rejects it as stale.
  db.db.prepare("UPDATE notes SET updated_at = '2027-01-01 00:00:00'").run();
  const clients = db.createFolder("Clients").folder;
  db.setFolderParent(roadmap.id, clients.id);
  browserLocalStorage.setItem("teamSpacesCapability", "true");
  return { cloudRoadmap, cloudPlan, clients };
}

test("a folder leaving a team retracts at once and nests once its new parent exists", async (t) => {
  const ctx = await setupPersonal(t);
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

test(
  "a folder leaving a team pushes its retraction under a private parent that never syncs",
  {
    todo: "main's wider blocked set holds a left_team note while its Private folder stays pending for a withheld parent (open question from the #3002 port)",
  },
  async (t) => {
    const ctx = await setupPersonal(t);
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
  }
);

// A synced team folder "Roadmap" and its synced subfolder "Q1", each holding a
// synced note; Q1 also holds a teammate's.
function seedTeamSubfolder(db, cloud) {
  const team = db.db
    .prepare(
      "INSERT INTO spaces (client_space_id, kind, name, sort_order, cloud_space_id) VALUES (?, 'team', ?, 1, ?)"
    )
    .run("team-carried", "Growth", "cloud-growth").lastInsertRowid;
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team, db.activeAccountId);
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
  const retro = db.saveNote("Retro", "body", "personal", null, null, quarter.folder.id, team).note;
  const cloudRetro = cloud.seedNote({ client_note_id: retro.client_note_id, title: "Retro" });
  db.markNoteSynced(retro.id, cloudRetro.id, null, "teammate");
  browserLocalStorage.setItem("teamSpacesCapability", "true");
  return { roadmap, quarter, cloudRetro };
}

// The seeded folders, moved to the private space together.
function carryTeamSubfolderOut(db, cloud) {
  const seeded = seedTeamSubfolder(db, cloud);
  leaveTeamAsOlderBuild(db, seeded.roadmap.folder.id, db.getPrivateSpaceId());
  // The move comes after the seeded cloud notes, or the cloud rejects it as stale.
  db.db.prepare("UPDATE notes SET updated_at = '2027-01-01 00:00:00'").run();
  return seeded;
}

function assertCarriedRetraction(db, cloud, { roadmap, quarter, cloudRetro }) {
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
      // A teammate's note stays in the team and leaves the folder.
      [cloudRetro.id, "cloud-growth", null],
    ].sort()
  );
  const q1 = folderByName(db, "Q1");
  assert.equal(q1.parent_folder_id, roadmap.folder.id, "the pull keeps the unpushed nesting");
  assert.equal(q1.sync_status, "pending");
  assert.equal(folderByName(db, "Roadmap").sync_status, "synced");
  assert.equal(db.db.prepare("SELECT 1 FROM folders WHERE left_team = 1").get(), undefined);
  assert.equal(db.db.prepare("SELECT 1 FROM notes WHERE left_team = 1").get(), undefined);
}

test(
  "a subfolder carried out of a team retracts with its parent, then nests under it",
  {
    todo: "main's wider blocked set holds a left_team note while its Private folder stays pending for a withheld parent (open question from the #3002 port)",
  },
  async (t) => {
    const ctx = await setupPersonal(t);
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
  }
);

test(
  "without backup, a carried subfolder retracts with its parent and nests once backup is on",
  {
    todo: "main's wider blocked set holds a left_team note while its Private folder stays pending for a withheld parent (open question from the #3002 port)",
  },
  async (t) => {
    const ctx = await setupPersonal(t);
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
  }
);

test("without backup, a pulled move out of a team keeps the carried subfolder nested", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const { roadmap } = seedTeamSubfolder(db, cloud);
  // Another device moved both to Private: the newer cloud rows carry no space.
  db.db.prepare("UPDATE folders SET updated_at = '2020-01-01 00:00:00'").run();

  browserLocalStorage.removeItem("cloudBackupEnabled");
  await (await newSyncService(t)).syncFolders(true);

  const q1 = folderByName(db, "Q1");
  assert.equal(q1.space_id, db.getPrivateSpaceId());
  assert.equal(q1.parent_folder_id, roadmap.folder.id);
});

function setNoteRow(db, id, columns) {
  const keys = Object.keys(columns);
  db.db
    .prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => columns[k]), id);
}

const noteById = (db, id) => db.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) ?? null;

// Another device's or teammate's write, reaching the server directly.
const fromElsewhere = (cloud, method, path, body) => cloud.request({ method, path, body });

// A delete in the millisecond the last pull stamped would fall behind the cursor.
const rewindFolderCursor = () =>
  browserLocalStorage.setItem("lastSyncedAt.folders", "2020-01-01T00:00:00.000Z");

const relocatedToasts = () =>
  browserWindow.electronAPI.syncEvents.filter((event) => event.name === "note-relocated");

test("another device's folder delete keeps every note until the note's own delete arrives", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const folder = db.createFolder("Client").folder;
  const clean = db.saveNote("Clean", "pushed", "personal", null, null, folder.id).note;
  const edited = db.saveNote("Edited", "pushed", "personal", null, null, folder.id).note;
  await service.syncAll(true);
  const cloudFolderId = folderByName(db, "Client").cloud_id;
  assert.ok(cloudFolderId);
  const editedClientId = noteById(db, edited.id).client_note_id;
  const editedCloudId = noteById(db, edited.id).cloud_id;

  // Offline edits and a brand new note, then the delete lands from elsewhere.
  db.updateNote(edited.id, { title: "Edited offline" });
  const unsent = db.saveNote("Unsent", "only here", "personal", null, null, folder.id).note;
  await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: cloudFolderId });
  rewindFolderCursor();

  assert.equal(await service.pullFolders(), true);

  assert.equal(folderByName(db, "Client"), null);
  const privateSpace = db.getPrivateSpaceId();
  for (const note of [clean, edited, unsent]) {
    const kept = noteById(db, note.id);
    assert.equal(kept.deleted_at, null, `${note.title} waits for its own delete`);
    assert.equal(kept.space_id, privateSpace);
    assert.equal(kept.folder_id, null);
  }
  assert.equal(noteById(db, edited.id).client_note_id, editedClientId, "nothing is forked");
  assert.equal(noteById(db, edited.id).cloud_id, editedCloudId);
  assert.equal(relocatedToasts().length, 0);

  // The note pull brings the server's own tombstones: the clean copy goes, the
  // unsent edit survives as a new note, and the never-sent note goes up unfiled.
  await service.syncAll(true);
  await service.syncAll(true);
  assert.equal(noteById(db, clean.id), null);
  const fork = noteById(db, edited.id);
  assert.equal(fork.title, "Edited offline");
  assert.notEqual(fork.client_note_id, editedClientId);
  assert.ok(fork.cloud_id);
  assert.equal(fork.sync_status, "synced");
  assert.equal(cloud.note(fork.cloud_id).deleted_at, null);
  assert.ok(noteById(db, unsent.id).cloud_id);
  assert.equal(noteById(db, unsent.id).sync_status, "synced");
});

test("another device's folder delete keeps a note the server holds unfiled, edits included", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  // An older build uploaded the note with no folder; this device still files it.
  const folder = db.createFolder("Client").folder;
  const cloudFolder = cloud.seedFolder({
    client_folder_id: folder.client_folder_id,
    name: "Client",
    is_default: false,
    sort_order: 1,
  });
  db.markFolderSynced(folder.id, cloudFolder.id);
  const note = db.saveNote("Unfiled up there", "body", "personal", null, null, folder.id).note;
  const cloudNote = cloud.seedNote({ client_note_id: note.client_note_id, title: note.title });
  db.markNoteSynced(note.id, cloudNote.id, cloudNote.updated_at);
  db.updateNote(note.id, { title: "Edited here" });
  // The edit comes after the seeded cloud note, or the cloud rejects it as stale.
  db.db.prepare("UPDATE notes SET updated_at = '2027-01-01 00:00:00'").run();
  await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: cloudFolder.id });
  rewindFolderCursor();

  await (await newSyncService(t)).syncAll(true);

  const kept = noteById(db, note.id);
  assert.equal(kept.deleted_at, null);
  assert.equal(kept.folder_id, null);
  assert.equal(kept.cloud_id, cloudNote.id, "the same cloud note, not a copy");
  assert.equal(kept.sync_status, "synced");
  assert.equal(cloud.note(cloudNote.id).title, "Edited here");
  assert.equal(cloud.note(cloudNote.id).deleted_at, null);
  assert.equal(cloud.notes().length, 1, "no duplicate");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 1);
});

test("a note created into a folder the server already deleted is kept", async (t) => {
  const ctx = await setupPersonal(t, { userId: TEAM_ACCOUNT });
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const folder = db.createFolder("Client").folder;
  await service.syncAll(true);
  const cloudFolderId = folderByName(db, "Client").cloud_id;
  await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: cloudFolderId });
  rewindFolderCursor();
  // A debounced push sends it before any pull: the server drops the dead folder.
  const note = db.saveNote("Late", "body", "personal", null, null, folder.id).note;
  await service.pushPendingNotes();
  const cloudNoteId = noteById(db, note.id).cloud_id;
  assert.equal(cloud.note(cloudNoteId).folder_id, null);
  assert.equal(noteById(db, note.id).sync_status, "folder_link_pending");

  await service.syncAll(true);

  const kept = noteById(db, note.id);
  assert.equal(kept.deleted_at, null);
  assert.equal(kept.folder_id, null);
  assert.equal(kept.cloud_id, cloudNoteId);
  assert.equal(kept.sync_status, "synced");
  assert.equal(cloud.note(cloudNoteId).deleted_at, null);
  assert.equal(cloud.notes().length, 1);
});

test("a note uploaded while its folder got its first cloud id sends the link after", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const folder = db.createFolder("Client").folder;
  const note = db.saveNote("Racing", "body", "personal", null, null, folder.id).note;
  // Past its wait, the note uploads without the folder.
  backdateFolderWait(folder.client_folder_id, 31);
  t.mock.method(console, "warn", () => {});
  const api = browserWindow.electronAPI;
  const request = api.cloudApiRequest;
  t.mock.method(api, "cloudApiRequest", async (options) => {
    const response = await request(options);
    // The folder's create and acknowledgement land while the note's is in flight.
    if (options.path.startsWith("/api/notes/batch-create")) await service.pushPendingFolders();
    return response;
  });

  await service.pushPendingNotes();
  const cloudFolderId = folderByName(db, "Client").cloud_id;
  assert.ok(cloudFolderId);
  assert.equal(noteById(db, note.id).sync_status, "folder_link_pending");

  await service.pushPendingNotes();
  assert.equal(cloud.note(noteById(db, note.id).cloud_id).folder_id, cloudFolderId);
  assert.equal(noteById(db, note.id).sync_status, "synced");
  assert.equal(noteById(db, note.id).folder_id, folder.id);
});

test("this device's own folder delete, seen again in a pull, resurrects nothing", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const folder = db.createFolder("Client").folder;
  const edited = db.saveNote("Edited", "pushed", "personal", null, null, folder.id).note;
  await service.syncAll(true);
  const cloudFolderId = folderByName(db, "Client").cloud_id;

  db.updateNote(edited.id, { title: "Edited offline" });
  const unsent = db.saveNote("Unsent", "held", "personal", null, null, folder.id).note;
  assert.equal(db.deleteFolder(folder.id).success, true);
  await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: cloudFolderId });
  rewindFolderCursor();

  assert.equal(await service.pullFolders(), true);

  assert.equal(noteById(db, edited.id), null);
  assert.equal(noteById(db, unsent.id), null);
  assert.equal(relocatedToasts().length, 0);
});

test("a teammate's team folder delete keeps unsent team notes in the team on a team-only pass", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  seedTeamSubfolder(db, cloud);
  browserLocalStorage.removeItem("cloudBackupEnabled");
  const quarter = folderByName(db, "Q1");
  const unsent = db.saveNote("Team draft", "unsent", "personal", null, null, quarter.id).note;
  browserLocalStorage.setItem("lastSyncedAt.folders.team", "2026-01-01T00:00:00.000Z");
  await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: quarter.cloud_id });

  const service = await newSyncService(t);
  assert.equal(await service.pullFolders(true), true);

  const kept = noteById(db, unsent.id);
  assert.equal(kept.space_id, quarter.space_id);
  assert.equal(kept.folder_id, null);
  assert.equal(folderByName(db, "Q1"), null);
  assert.ok(folderByName(db, "Roadmap"));
});

test("a pulled folder delete needs no Private space and holds no cursor back", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const folder = db.createFolder("Client").folder;
  await service.syncAll(true);
  const cloudFolderId = folderByName(db, "Client").cloud_id;
  const unsent = db.saveNote("Unsent", "only here", "personal", null, null, folder.id).note;
  await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: cloudFolderId });
  rewindFolderCursor();
  const stamp = browserLocalStorage.getItem("lastSyncedAt.folders");
  t.mock.method(db, "_forkPrivateSpaceId", () => null);

  assert.equal(await service.pullFolders(), true);

  assert.equal(noteById(db, unsent.id).folder_id, null);
  assert.notEqual(browserLocalStorage.getItem("lastSyncedAt.folders"), stamp);
});

test("a denied delete restores a never-synced subfolder, and never sends it a DELETE", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const parent = db.createFolder("Client").folder;
  await service.syncAll(true);
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "down" });
  const subfolder = db.createFolder("Q1", null, parent.id).folder;
  const note = db.saveNote("Plan", "local", "personal", null, null, subfolder.id).note;
  cloud.clearFailures();

  assert.equal(db.deleteFolder(parent.id).success, true);
  cloud.failNext("DELETE /api/folders/delete", {
    status: 403,
    code: "folder_access_denied",
    error: "denied",
  });
  await service.pushFolderDeletes();

  const deletes = cloud.logFor("/api/folders/delete");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].body.id, folderByName(db, "Client").cloud_id);
  const restored = folderByName(db, "Q1");
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.parent_folder_id, parent.id);
  assert.equal(noteById(db, note.id).deleted_at, null);
  assert.equal(noteById(db, note.id).folder_id, subfolder.id);

  await service.syncAll(true);
  assert.equal(
    cloud.folder(folderByName(db, "Q1").cloud_id).parent_folder_id,
    folderByName(db, "Client").cloud_id
  );
});

test("a confirmed delete tombstones a never-synced subfolder's uploaded note on the server", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const parent = db.createFolder("Client").folder;
  await service.syncAll(true);
  const subfolder = db.createFolder("Q1", null, parent.id).folder;
  const uploaded = db.saveNote("Uploaded", "went up", "personal", null, null, subfolder.id).note;
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "down" });
  await service.pushPendingFolders();
  backdateFolderWait(subfolder.client_folder_id, 31);
  await service.pushPendingNotes();
  const cloudNoteId = noteById(db, uploaded.id).cloud_id;
  assert.ok(cloudNoteId, "past the wait limit the subfolder's note uploads");
  cloud.clearFailures();

  assert.equal(db.deleteFolder(parent.id).success, true);
  await service.pushFolderDeletes();
  assert.equal(folderByName(db, "Q1"), null);
  await service.pushNoteDeletes();

  assert.ok(cloud.note(cloudNoteId).deleted_at, "its own tombstone reached the server");
  assert.equal(noteById(db, uploaded.id), null);
});

test("more than 50 new folders push in chunks, parents before subfolders", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  await service.syncAll(true);
  const parents = Array.from({ length: 60 }, (_, index) => {
    const parent = db.createFolder(`Parent ${String(index).padStart(2, "0")}`).folder;
    db.createFolder(`Child ${String(index).padStart(2, "0")}`, null, parent.id);
    return parent;
  });
  const before = cloud.logFor("/api/folders/batch-create").length;

  await service.pushPendingFolders();

  const batches = cloud.logFor("/api/folders/batch-create").slice(before);
  assert.deepEqual(
    batches.map((call) => call.body.folders.length),
    [50, 10, 50, 10]
  );
  assert.ok(batches.slice(0, 2).every((b) => b.body.folders.every((f) => !f.parent_folder_id)));
  assert.ok(batches.slice(2).every((b) => b.body.folders.every((f) => f.parent_folder_id)));
  for (const parent of parents) {
    const child = db.getSubfolders(parent.id)[0];
    assert.equal(child.sync_status, "synced");
    assert.equal(
      cloud.folder(child.cloud_id).parent_folder_id,
      folderByClientId(db, parent.client_folder_id).cloud_id
    );
  }
});

test("a failed chunk doesn't strand the folders in the other chunks", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  await service.syncAll(true);
  for (let index = 0; index < 60; index++) {
    db.createFolder(`Folder ${String(index).padStart(2, "0")}`);
  }
  t.mock.method(console, "error", () => {});
  cloud.failNext("POST /api/folders/batch-create", { status: 500, error: "down" });

  // The signed-out stand-in's default folders aren't this account's to push.
  const pending = () =>
    allFolders(db).filter((f) => f.name.startsWith("Folder ") && f.sync_status === "pending");

  await service.pushPendingFolders();

  assert.equal(pending().length, 50);
  await service.pushPendingFolders();
  assert.equal(pending().length, 0);
});

// A cloud-backed parent whose PATCH keeps failing, holding a new subfolder.
async function waitingSubfolder(db, cloud, service) {
  const parent = db.createFolder("Client").folder;
  await service.syncAll(true);
  db.renameFolder(parent.id, "Client renamed");
  setFolderRow(db, parent.id, { updated_at: "2027-01-01 00:00:00" });
  const subfolder = db.createFolder("Q1", null, parent.id).folder;
  cloud.failWith("PATCH /api/folders/update", { status: 500, error: "down" });
  return { parent, subfolder };
}

test("a waiting subfolder's note uploads unfiled after the limit, then links once the folder lands", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { subfolder } = await waitingSubfolder(db, cloud, service);
  const note = db.saveNote("Plan", "body", "personal", null, null, subfolder.id).note;
  t.mock.method(console, "error", () => {});
  const warnings = t.mock.method(console, "warn", () => {});

  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0, "inside the limit it waits");
  const started = JSON.parse(browserLocalStorage.getItem("folderWaitStartedAt"));
  assert.ok(started[subfolder.client_folder_id], "the wait was recorded by client id");

  backdateFolderWait(subfolder.client_folder_id, 29);
  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/notes/batch-create").length, 0);

  backdateFolderWait(subfolder.client_folder_id, 31);
  await service.syncAll(true);
  const [upload] = cloud.logFor("/api/notes/batch-create");
  assert.ok(upload, "past the limit the note uploads");
  assert.equal(upload.body.notes[0].folder_id, null);
  const uploaded = noteById(db, note.id);
  assert.equal(uploaded.folder_id, subfolder.id, "the local folder stays");
  assert.equal(uploaded.sync_status, "synced");
  assert.ok(warnings.mock.calls.some((c) => String(c.arguments[0]).includes("no cloud id")));

  cloud.clearFailures();
  await service.syncAll(true);
  const cloudSubfolderId = folderByName(db, "Q1").cloud_id;
  assert.ok(cloudSubfolderId);
  assert.equal(cloud.note(uploaded.cloud_id).folder_id, cloudSubfolderId);
  assert.equal(noteById(db, note.id).sync_status, "synced");
  assert.equal(noteById(db, note.id).folder_id, subfolder.id);
  assert.equal(browserLocalStorage.getItem("folderWaitStartedAt"), null, "the entry is cleared");
});

test("a debounced note push honours the same wait limit", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { subfolder } = await waitingSubfolder(db, cloud, service);
  const note = db.saveNote("Plan", "body", "personal", null, null, subfolder.id).note;
  t.mock.method(console, "warn", () => {});

  await service.pushEntity("note", note.id);
  assert.equal(cloud.logFor("/api/notes/create").length, 0);

  backdateFolderWait(subfolder.client_folder_id, 31);
  await service.pushEntity("note", note.id);
  const [create] = cloud.logFor("/api/notes/create");
  assert.ok(create);
  assert.equal(create.body.folder_id, null);
  assert.equal(noteById(db, note.id).folder_id, subfolder.id);
});

test("a note leaving a team still waits for a cloud-backed folder's unlanded move", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const { roadmap } = carryTeamSubfolderOut(db, cloud);
  const local = noteByClientId(db, roadmap.cloudNote.client_note_id);
  assert.equal(local.left_team, 1);
  browserLocalStorage.setItem(
    "folderWaitStartedAt",
    JSON.stringify({ [folderByName(db, "Roadmap").client_folder_id]: 0 })
  );

  await (await newSyncService(t)).pushPendingNotes();

  assert.ok(
    !cloud.logFor("/api/notes/update").some((call) => call.body.id === roadmap.cloudNote.id),
    "the existing rule is unchanged"
  );
  assert.equal(noteById(db, local.id).left_team, 1);
});

test("a team note moved into a waiting private folder retracts at once, unfiled", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { subfolder } = await waitingSubfolder(db, cloud, service);
  const { cloudNote: cloudRoadmapNote } = seedTeamSubfolder(db, cloud).roadmap;
  const local = noteByClientId(db, cloudRoadmapNote.client_note_id);
  // D31 refuses moving a synced team note to Private: the state an older build left.
  setNoteRow(db, local.id, {
    space_id: subfolder.space_id,
    folder_id: subfolder.id,
    left_team: 1,
    sync_status: "pending",
    updated_at: "2027-01-01 00:00:00",
  });

  await service.pushPendingNotes();

  const patch = cloud.logFor("/api/notes/update").at(-1);
  assert.equal(patch.body.id, cloudRoadmapNote.id);
  assert.equal(patch.body.folder_id, null);
  assert.equal(patch.body.space_id, null);
  const settled = noteById(db, local.id);
  assert.equal(settled.left_team, 0);
  assert.equal(settled.folder_id, subfolder.id);
  assert.equal(settled.sync_status, "synced");
});

test("a note that uploaded before its folder existed gets its link exactly once", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  t.mock.method(console, "error", () => {});
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "down" });
  const folder = db.createFolder("Client").folder;
  const note = db.saveNote("Plan", "body", "personal", null, null, folder.id).note;
  backdateFolderWait(folder.client_folder_id, 31);
  await service.syncAll(true);
  const cloudNoteId = noteById(db, note.id).cloud_id;
  assert.equal(cloud.note(cloudNoteId).folder_id, null);
  assert.equal(noteById(db, note.id).sync_status, "synced");

  cloud.clearFailures();
  const updatedAt = noteById(db, note.id).updated_at;
  await service.pushPendingFolders();
  const queued = noteById(db, note.id);
  assert.equal(queued.sync_status, "folder_link_pending");
  assert.equal(queued.updated_at, updatedAt, "nothing was edited");

  await service.syncAll(true);
  const cloudFolderId = folderByName(db, "Client").cloud_id;
  assert.equal(cloud.note(cloudNoteId).folder_id, cloudFolderId);
  const patches = () => cloud.logFor("/api/notes/update").filter((c) => c.body.id === cloudNoteId);
  assert.equal(patches().length, 1);
  assert.equal(noteById(db, note.id).sync_status, "synced");
  assert.equal(noteById(db, note.id).folder_id, folder.id);

  db.renameFolder(folder.id, "Client renamed");
  setFolderRow(db, folder.id, { updated_at: "2027-01-01 00:00:00" });
  await service.syncAll(true);
  await service.syncAll(true);
  assert.equal(patches().length, 1, "later syncs of the folder don't send it again");
});

test("a newer cloud copy over a queued link is applied, never raised as a conflict", async (t) => {
  const ctx = await setupPersonal(t, { revisionGuard: true });
  if (!ctx) return;
  const { db, cloud } = ctx;
  const { readNoteConflictIds } = await import("../../src/lib/noteConflictRegistry.ts");
  const service = await newSyncService(t);
  t.mock.method(console, "error", () => {});
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "down" });
  const folder = db.createFolder("Client").folder;
  const note = db.saveNote("Plan", "body", "personal", null, null, folder.id).note;
  backdateFolderWait(folder.client_folder_id, 31);
  await service.syncAll(true);
  const uploaded = noteById(db, note.id);
  assert.equal(uploaded.cloud_revision, 0);

  // Another device edits the note before this device's folder reaches the cloud.
  await fromElsewhere(cloud, "PATCH", "/api/notes/update", {
    id: uploaded.cloud_id,
    base_revision: 0,
    title: "Plan from phone",
    updated_at: "2027-01-01T00:00:00.000Z",
  });
  cloud.clearFailures();

  // Its first PATCH carries the stale base: 409, no banner. The pull in the same
  // pass takes the newer copy and keeps the folder for the retry.
  await service.syncAll(true);
  assert.deepEqual([...readNoteConflictIds()], []);
  const afterConflict = noteById(db, note.id);
  assert.equal(afterConflict.title, "Plan from phone");
  assert.equal(afterConflict.folder_id, folder.id);
  assert.equal(afterConflict.sync_status, "folder_link_pending");
  assert.equal(cloud.note(uploaded.cloud_id).folder_id, null);

  await service.syncAll(true);
  const cloudFolderId = folderByName(db, "Client").cloud_id;
  const remote = cloud.note(uploaded.cloud_id);
  assert.equal(remote.folder_id, cloudFolderId);
  assert.equal(remote.title, "Plan from phone");
  assert.equal(noteById(db, note.id).sync_status, "synced");
  assert.deepEqual([...readNoteConflictIds()], []);
});

test("a local edit over a queued link is real work: a newer cloud copy conflicts", async (t) => {
  const ctx = await setupPersonal(t, { revisionGuard: true });
  if (!ctx) return;
  const { db, cloud } = ctx;
  const { readNoteConflictIds } = await import("../../src/lib/noteConflictRegistry.ts");
  const service = await newSyncService(t);
  t.mock.method(console, "error", () => {});
  cloud.failWith("POST /api/folders/batch-create", { status: 500, error: "down" });
  const folder = db.createFolder("Client").folder;
  const note = db.saveNote("Plan", "body", "personal", null, null, folder.id).note;
  backdateFolderWait(folder.client_folder_id, 31);
  await service.syncAll(true);
  const uploaded = noteById(db, note.id);
  await fromElsewhere(cloud, "PATCH", "/api/notes/update", {
    id: uploaded.cloud_id,
    base_revision: 0,
    title: "Plan from phone",
    updated_at: "2027-01-01T00:00:00.000Z",
  });
  cloud.clearFailures();
  await service.pushPendingFolders();
  assert.equal(noteById(db, note.id).sync_status, "folder_link_pending");

  db.updateNote(note.id, { title: "Plan edited here" });
  await service.pushPendingNotes();

  assert.deepEqual([...readNoteConflictIds()], [uploaded.client_note_id]);
  assert.equal(noteById(db, note.id).title, "Plan edited here");
  assert.equal(noteById(db, note.id).sync_status, "pending");
});

// A device from before subfolders: every row flat and clean, cursors current,
// while the cloud already nests Q1 under Client.
async function upgradedDevice(db, cloud, service) {
  const parent = db.createFolder("Client").folder;
  const child = db.createFolder("Q1").folder;
  await service.pushPendingFolders();
  const cloudParentId = folderByClientId(db, parent.client_folder_id).cloud_id;
  const cloudChildId = folderByClientId(db, child.client_folder_id).cloud_id;
  await fromElsewhere(cloud, "PATCH", "/api/folders/update", {
    id: cloudChildId,
    parent_folder_id: cloudParentId,
    updated_at: "2027-02-01T00:00:00.000Z",
  });
  const stamp = "2027-02-15T00:00:00.000Z";
  // Cursors this account owns, so its pass doesn't replay them as unowned.
  browserLocalStorage.setItem("lastSyncedAt.accountId", TEAM_ACCOUNT);
  browserLocalStorage.setItem("lastSyncedAt.folders", stamp);
  browserLocalStorage.setItem("lastSyncedAt.notes", stamp);
  setFolderRow(db, child.id, { updated_at: "2027-02-01 00:00:00" });
  return { parent, child, cloudParentId, cloudChildId, stamp };
}

test("an upgraded device links a flat local subfolder and never flattens it", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { parent, child, cloudParentId, cloudChildId, stamp } = await upgradedDevice(
    db,
    cloud,
    service
  );
  const updatesBefore = cloud.logFor("/api/folders/update").length;

  await service.syncAll(true);

  assert.equal(folderByClientId(db, child.client_folder_id).parent_folder_id, parent.id);
  assert.equal(cloud.logFor("/api/folders/update").length, updatesBefore, "no PATCH at all");
  assert.equal(cloud.folder(cloudChildId).parent_folder_id, cloudParentId);
  const lists = cloud.logFor("/api/folders/list");
  assert.equal(lists[0].path, "/api/folders/list", "the backfill is a full list");
  assert.equal(lists[1].path, `/api/folders/list?since=${encodeURIComponent(stamp)}`);

  const listCount = lists.length;
  browserLocalStorage.setItem("lastSyncedAt.folders", stamp);
  await service.syncAll(true);
  assert.equal(cloud.logFor("/api/folders/list").length, listCount + 1, "the backfill is one-shot");
});

test("an upgraded device's offline rename keeps the nesting it couldn't have known about", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { parent, child, cloudParentId, cloudChildId } = await upgradedDevice(db, cloud, service);
  db.renameFolder(child.id, "Q1 renamed");
  setFolderRow(db, child.id, { updated_at: "2027-03-01 00:00:00" });

  await service.syncAll(true);

  const remote = cloud.folder(cloudChildId);
  assert.equal(remote.name, "Q1 renamed");
  assert.equal(remote.parent_folder_id, cloudParentId);
  assert.ok(
    cloud.logFor("/api/folders/update").every((call) => call.body.parent_folder_id !== null),
    "no PATCH sends a null parent"
  );
  const local = folderByClientId(db, child.client_folder_id);
  assert.equal(local.parent_folder_id, parent.id);
  assert.equal(local.sync_status, "synced");
});

test("an upgraded device's synced row links even when its local clock ran ahead of the cloud", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { parent, child } = await upgradedDevice(db, cloud, service);
  setFolderRow(db, child.id, { updated_at: "2027-06-01 00:00:00" });

  await service.syncAll(true);

  assert.equal(folderByClientId(db, child.client_folder_id).parent_folder_id, parent.id);
});

test("a pending row with a local parent keeps it through the backfill", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { child, cloudChildId } = await upgradedDevice(db, cloud, service);
  const chosen = db.createFolder("Chosen").folder;
  await service.pushPendingFolders();
  assert.equal(db.setFolderParent(child.id, chosen.id).success, true);
  setFolderRow(db, child.id, { updated_at: "2027-03-01 00:00:00" });

  await service.syncAll(true);

  assert.equal(folderByClientId(db, child.client_folder_id).parent_folder_id, chosen.id);
  assert.equal(
    cloud.folder(cloudChildId).parent_folder_id,
    folderByClientId(db, chosen.client_folder_id).cloud_id
  );
});

test("a failed backfill skips the folder push and retries next pass", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { parent, child, cloudParentId, cloudChildId } = await upgradedDevice(db, cloud, service);
  db.renameFolder(child.id, "Q1 renamed");
  setFolderRow(db, child.id, { updated_at: "2027-03-01 00:00:00" });
  const updatesBefore = cloud.logFor("/api/folders/update").length;
  t.mock.method(console, "error", () => {});
  cloud.failNext("/api/folders/list", { status: 500, error: "list down" });

  await service.syncFolders();

  assert.equal(cloud.logFor("/api/folders/update").length, updatesBefore, "nothing was pushed");
  assert.equal(cloud.folder(cloudChildId).parent_folder_id, cloudParentId);
  assert.equal(folderByClientId(db, child.client_folder_id).sync_status, "pending");

  await service.syncFolders();

  assert.equal(folderByClientId(db, child.client_folder_id).parent_folder_id, parent.id);
  assert.equal(cloud.folder(cloudChildId).name, "Q1 renamed");
  assert.equal(cloud.folder(cloudChildId).parent_folder_id, cloudParentId);
});

test("a failed backfill still creates new folders, so a list that keeps failing can't stop backups", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { child, cloudChildId } = await upgradedDevice(db, cloud, service);
  db.renameFolder(child.id, "Q1 renamed");
  const fresh = db.createFolder("Started offline").folder;
  t.mock.method(console, "error", () => {});
  cloud.failWith("/api/folders/list", { status: 500, error: "list down" });

  await service.syncFolders();
  await service.syncFolders();

  assert.ok(folderByClientId(db, fresh.client_folder_id).cloud_id, "the new folder went up");
  assert.notEqual(cloud.folder(cloudChildId).name, "Q1 renamed", "a flat row still waits");
  assert.equal(folderByClientId(db, child.client_folder_id).sync_status, "pending");
});

test("a pulled delete of a folder whose create receipt was lost leaves its uploaded note live everywhere", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  await service.syncAll(true);

  // The create reached the server but this device never got the receipt, and the
  // note went up with no folder. Another device then deleted the empty folder.
  const folder = db.createFolder("Client").folder;
  const cloudFolder = cloud.seedFolder({
    name: "Client",
    client_folder_id: folder.client_folder_id,
  });
  const note = db.saveNote("Plan", "the only text", "personal", null, null, folder.id).note;
  const cloudNote = cloud.seedNote({ client_note_id: note.client_note_id, title: "Plan" });
  db.db
    .prepare(
      "UPDATE notes SET cloud_id = ?, cloud_revision = 1, sync_status = 'synced' WHERE id = ?"
    )
    .run(cloudNote.id, note.id);
  const stamp = browserLocalStorage.getItem("lastSyncedAt.folders");
  cloud.setClock(() => shift(stamp, 1));
  await cloud.request({
    method: "DELETE",
    path: "/api/folders/delete",
    body: { id: cloudFolder.id },
  });
  t.mock.method(console, "error", () => {});
  cloud.failNext("POST /api/folders/batch-create", { status: 503, error: "busy" });
  cloud.failNext("POST /api/folders/create", { status: 503, error: "busy" });

  await service.syncAll(true);
  await service.syncAll(true);

  assert.equal(cloud.note(cloudNote.id).deleted_at, null, "nobody chose to delete this note");
  const kept = db.getNote(note.id);
  assert.equal(kept.deleted_at, null);
  assert.equal(kept.content, "the only text");
  assert.notEqual(kept.folder_id, folder.id);
  assert.equal(folderByClientId(db, folder.client_folder_id) ?? null, null);
});

test("a debounced folder push waits for the backfill rather than flatten the row", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { child, cloudChildId, cloudParentId } = await upgradedDevice(db, cloud, service);
  db.renameFolder(child.id, "Q1 renamed");
  const updatesBefore = cloud.logFor("/api/folders/update").length;
  t.mock.method(service, "requestSyncAll", () => {});

  await service.pushEntity("folder", child.id);

  assert.equal(cloud.logFor("/api/folders/update").length, updatesBefore);
  assert.equal(cloud.folder(cloudChildId).parent_folder_id, cloudParentId);
});

test("an API without parent_folder_id links nothing and still finishes the backfill", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const { child } = await upgradedDevice(db, cloud, service);
  const request = browserWindow.electronAPI.cloudApiRequest;
  t.mock.method(browserWindow.electronAPI, "cloudApiRequest", async (options) => {
    const response = await request(options);
    if (options.path.startsWith("/api/folders/list")) {
      for (const folder of response.data.folders) delete folder.parent_folder_id;
    }
    return response;
  });

  assert.equal(await service.backfillFolderParents(false), true);

  assert.equal(folderByClientId(db, child.client_folder_id).parent_folder_id, null);
  assert.deepEqual(service.owedFolderParentBackfills(false), []);
});

test("a parked row retries the backfill without holding folder pushes back", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  const service = await newSyncService(t);
  const fresh = db.createFolder("Fresh").folder;
  t.mock.method(console, "warn", () => {});
  browserLocalStorage.setItem("teamSpacesCapability", "true");
  cloud.seedFolder({
    client_folder_id: "cf-unknown-space",
    name: "Elsewhere",
    space_id: "cloud-unknown",
  });
  const request = browserWindow.electronAPI.cloudApiRequest;
  t.mock.method(browserWindow.electronAPI, "cloudApiRequest", async (options) => {
    const response = await request(options);
    if (options.path.startsWith("/api/folders/list")) {
      for (const folder of response.data.folders) {
        if (folder.client_folder_id === "cf-unknown-space") folder.space_id = "cloud-unknown";
      }
    }
    return response;
  });

  await service.syncFolders();

  assert.ok(folderByClientId(db, fresh.client_folder_id).cloud_id, "the push still ran");
  assert.ok(service.owedFolderParentBackfills(false).length > 0, "the backfill is still owed");
});

test("a backup-off team-only pass backfills team folders only", async (t) => {
  const ctx = await setupPersonal(t);
  if (!ctx) return;
  const { db, cloud } = ctx;
  seedTeamSubfolder(db, cloud);
  const quarter = folderByName(db, "Q1");
  const roadmap = folderByName(db, "Roadmap");
  setFolderRow(db, quarter.id, { parent_folder_id: null });
  browserLocalStorage.removeItem("cloudBackupEnabled");
  browserLocalStorage.setItem("lastSyncedAt.folders.team", "2027-01-01T00:00:00.000Z");
  const request = browserWindow.electronAPI.cloudApiRequest;
  t.mock.method(browserWindow.electronAPI, "cloudApiRequest", async (options) => {
    const response = await request(options);
    if (options.path.startsWith("/api/folders/list")) {
      for (const folder of response.data.folders) folder.space_id = "cloud-growth";
    }
    return response;
  });
  const service = await newSyncService(t);

  await service.syncFolders(true);

  assert.equal(folderByName(db, "Q1").parent_folder_id, roadmap.id);
  assert.deepEqual(service.owedFolderParentBackfills(true), []);
  assert.equal(service.owedFolderParentBackfills(false).length, 1, "personal rows are still owed");
});

for (const subfolderFirst of [true, false]) {
  test(`a re-parent survives its old parent's delete when the page lists the ${subfolderFirst ? "subfolder" : "tombstone"} first`, async (t) => {
    const ctx = await setupPersonal(t);
    if (!ctx) return;
    const { db, cloud } = ctx;
    const service = await newSyncService(t);
    const oldParent = db.createFolder("Old").folder;
    const newParent = db.createFolder("New").folder;
    db.createFolder("Child", null, oldParent.id);
    await service.syncFolders();
    await service.syncFolders();
    const cloudOld = folderByName(db, "Old").cloud_id;
    const cloudNew = folderByName(db, "New").cloud_id;
    const cloudChild = folderByName(db, "Child").cloud_id;
    assert.equal(folderByName(db, "Child").parent_folder_id, oldParent.id);
    browserLocalStorage.setItem("lastSyncedAt.folders", "2020-01-01T00:00:00.000Z");

    // The fake lists a delta by sort_order, which sets the page's order here.
    await fromElsewhere(cloud, "PATCH", "/api/folders/update", {
      id: cloudChild,
      parent_folder_id: cloudNew,
      sort_order: subfolderFirst ? -1 : 100,
      updated_at: "2027-01-01T00:00:00.000Z",
    });
    await fromElsewhere(cloud, "DELETE", "/api/folders/delete", { id: cloudOld });

    assert.equal(await service.pullFolders(), true);

    assert.equal(folderByName(db, "Old"), null);
    assert.equal(folderByName(db, "Child").parent_folder_id, newParent.id);
    assert.equal(folderByName(db, "Child").sync_status, "synced");
  });
}
