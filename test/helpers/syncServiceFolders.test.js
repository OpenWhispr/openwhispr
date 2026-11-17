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

test("pushPendingFolders sends name/client_folder_id/is_default/sort_order in row order and links each folder on ack", async (t) => {
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
      "sort_order",
      "space_id",
      "workspace_id",
    ]);
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
    ...TEAM_SCOPE,
  });
  assert.deepEqual(patches[1].body, {
    id: betaCloudId,
    name: "Beta Renamed",
    sort_order: 2,
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
