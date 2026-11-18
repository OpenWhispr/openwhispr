// Two local accounts on one device, end to end: the real SyncService over the
// real cloudApi/FoldersService/NotesService stack and a real DatabaseManager,
// with one fake cloud per account. Signing in or out follows useAuth: the
// main-process account scope changes (and seeds the defaults that scope is
// missing, as the scope IPC does), the renderer's validated auth context is
// rebound, and localStorage (including the pull cursors) carries over.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
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
const DEFAULT_NAMES = ["Personal", "Meetings"];

function accountCloud(userId, { serverDefaults }) {
  const cloud = createFakeCloud({ userId, adoptDefaultFolders: true, revisionGuard: true });
  if (serverDefaults) {
    DEFAULT_NAMES.forEach((name, index) =>
      cloud.seedFolder({
        client_folder_id: `${userId}-${name.toLowerCase()}`,
        name,
        is_default: true,
        sort_order: index,
        created_at: "2026-01-01T00:00:00.000Z",
      })
    );
  }
  return cloud;
}

async function signIn(t, db, accountId, cloud, { backup = true } = {}) {
  db.setActiveAccountId(accountId);
  db.claimSignedOutLocalRows();
  db.claimLegacyRowsOfOnlyAccount();
  db.claimSignedOutPrivateNotes();
  db.ensureAccountDefaultFolders();
  browserWindow.electronAPI = createElectronApi(db, { cloud });
  enableSync();
  if (!backup) browserLocalStorage.setItem("cloudBackupEnabled", "false");
  await establishValidatedAuth(accountId);
  return sync(t);
}

function signOut(db) {
  db.setActiveAccountId(null);
  db.ensureAccountDefaultFolders();
  browserLocalStorage.setItem("isSignedIn", "false");
}

async function sync(t) {
  const { SyncService } = await loadSync();
  const { useSharedDictionaryStore } = await import("../../src/stores/sharedDictionaryStore.ts");
  useSharedDictionaryStore.setState({ lastSyncedAt: null });
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  await service.syncAll(true);
  if (browserLocalStorage.getItem("cloudBackupEnabled") === "true") {
    assert.ok(useSharedDictionaryStore.getState().lastSyncedAt, "the full sync pass succeeds");
  }
  return service;
}

// The next launch must still open the database: a folder name two scopes
// share once stopped the app from starting.
function assertRelaunches(t) {
  const reopened = new DatabaseManager();
  t.after(() => reopened.db.close());
  assert.ok(reopened.getPrivateSpaceId());
}

function visibleDefaults(db) {
  return db
    .getFolders()
    .filter((folder) => folder.is_default)
    .map((folder) => `${folder.name}:${folder.account_id}`)
    .sort();
}

function ownDefaults(accountId) {
  const names = accountId == null ? [...DEFAULT_NAMES, "Videos"] : DEFAULT_NAMES;
  return names.map((name) => `${name}:${accountId}`).sort();
}

function folderOf(db, accountId, name) {
  return db.db
    .prepare("SELECT * FROM folders WHERE name = ? AND is_default = 1 AND account_id IS ?")
    .get(name, accountId);
}

function notesFor(db) {
  return db
    .getNotes(null, 100)
    .map((note) => note.title)
    .sort();
}

function cloudFolderId(cloud, name) {
  return cloud.folders().find((folder) => folder.name === name && !folder.deleted_at).id;
}

function cloudNote(cloud, title) {
  return cloud.notes().find((note) => note.title === title);
}

// B's account was created after A last synced on this device, so B's cloud rows
// are newer than the pull cursor A left behind and a delta pull delivers them.
function seedLaterAccount(userId) {
  const cloud = createFakeCloud({ userId, adoptDefaultFolders: true, revisionGuard: true });
  DEFAULT_NAMES.forEach((name, index) =>
    cloud.seedFolder({
      client_folder_id: `${userId}-${name.toLowerCase()}`,
      name,
      is_default: true,
      sort_order: index,
    })
  );
  return cloud;
}

for (const serverDefaults of [true, false]) {
  test(`two accounts on one device each get only their own defaults and notes (A's server defaults: ${serverDefaults})`, async (t) => {
    resetBrowserGlobals();
    const db = createDb(t);
    if (!db) return;
    const cloudA = accountCloud("account-a", { serverDefaults });

    db.setActiveAccountId(null);
    db.saveNote("Guest note", "before signing in", "personal");

    await signIn(t, db, "account-a", cloudA);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
    db.saveNote("A note", "a", "personal");
    db.saveNote("A meeting", "a", "meeting");
    await sync(t);
    assert.equal(cloudNote(cloudA, "Guest note").folder_id, cloudFolderId(cloudA, "Personal"));
    assert.equal(cloudNote(cloudA, "A meeting").folder_id, cloudFolderId(cloudA, "Meetings"));
    assert.equal(
      cloudA.folders().length,
      DEFAULT_NAMES.length,
      "A's cloud gets one copy of each used default"
    );

    signOut(db);
    assert.deepEqual(visibleDefaults(db), ownDefaults(null), "a signed-out guest gets its own");
    assert.deepEqual(notesFor(db), []);
    assert.ok(db.getMeetingsFolder(), "a signed-out meeting still has a Meetings folder");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const cloudB = seedLaterAccount("account-b");
    await signIn(t, db, "account-b", cloudB);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
    assert.deepEqual(notesFor(db), []);

    const bNote = db.saveNote("B note", "b", "personal").note;
    const bMeeting = db.saveNote("B meeting", "b", "meeting").note;
    assert.equal(bNote.folder_id, folderOf(db, "account-b", "Personal").id);
    assert.equal(bMeeting.folder_id, folderOf(db, "account-b", "Meetings").id);
    assert.equal(db.getMeetingsFolder().id, folderOf(db, "account-b", "Meetings").id);
    await sync(t);
    assert.equal(cloudNote(cloudB, "B note").folder_id, cloudFolderId(cloudB, "Personal"));
    assert.equal(cloudNote(cloudB, "B meeting").folder_id, cloudFolderId(cloudB, "Meetings"));
    assert.equal(cloudB.folders().length, DEFAULT_NAMES.length, "B pushes none of A's folders");
    assert.deepEqual(
      cloudB
        .notes()
        .map((note) => note.title)
        .sort(),
      ["B meeting", "B note"]
    );

    signOut(db);
    await signIn(t, db, "account-a", cloudA);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
    assert.deepEqual(notesFor(db), ["A meeting", "A note", "Guest note"]);
    assert.deepEqual(
      cloudA
        .notes()
        .map((note) => note.title)
        .sort(),
      ["A meeting", "A note", "Guest note"]
    );

    // Deleting A's account keeps B's rows and leaves B's view untouched.
    db.deleteAccountData("account-a");
    signOut(db);
    await signIn(t, db, "account-b", cloudB);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
    assert.deepEqual(notesFor(db), ["B meeting", "B note"]);
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE account_id = 'account-a'").get()
        .count,
      0
    );
    signOut(db);
    assertRelaunches(t);
  });
}

test("a pre-fix shared folder is repaired without giving either account the other's notes", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  const cloudB = accountCloud("account-b", { serverDefaults: true });
  const legacyPersonal = folderOf(db, null, "Personal");
  for (const folder of cloudA.folders()) {
    bindLegacyFolder(db, folder.name, folder, `legacy-${folder.name}`);
  }
  const localA = db.saveNote("A legacy note", "a", "personal").note;
  const localB = db.saveNote("B misrouted", "b", "personal").note;
  for (const [local, cloud, owner] of [
    [localA, cloudA, "account-a"],
    [localB, cloudB, "account-b"],
  ]) {
    const remote = cloud.seedNote({
      client_note_id: local.client_note_id,
      title: local.title,
      content: local.content,
      created_at: "2026-01-02T00:00:00.000Z",
      folder_id: owner === "account-a" ? cloudFolderId(cloudA, "Personal") : null,
    });
    db.db
      .prepare(
        "UPDATE notes SET cloud_id = ?, owner_user_id = ?, sync_status = 'synced' WHERE id = ?"
      )
      .run(remote.id, owner, local.id);
  }
  assert.equal(localA.folder_id, legacyPersonal.id);
  assert.equal(localB.folder_id, legacyPersonal.id);

  db._repairCloudBoundLegacyRows();
  db._splitPrivateSpaceByAccount();
  await signIn(t, db, "account-b", cloudB);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
  assert.deepEqual(notesFor(db), ["B misrouted"]);
  assert.equal(db.getNote(localB.id).folder_id, folderOf(db, "account-b", "Personal").id);
  await sync(t);
  assert.equal(cloudNote(cloudB, "B misrouted").folder_id, cloudFolderId(cloudB, "Personal"));
  assert.equal(folderOf(db, null, "Personal").cloud_id, cloudFolderId(cloudA, "Personal"));
  assert.equal(cloudB.folders().length, DEFAULT_NAMES.length);

  signOut(db);
  await signIn(t, db, "account-a", cloudA);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
  assert.deepEqual(notesFor(db), ["A legacy note"]);
  assert.equal(db.getNote(localA.id).content, "a");
  assert.equal(db.getNote(localA.id).folder_id, folderOf(db, "account-a", "Personal").id);
  assert.equal(cloudNote(cloudA, "A legacy note").folder_id, cloudFolderId(cloudA, "Personal"));
  assert.equal(cloudA.notes().length, 1);
  assert.equal(cloudA.folders().length, DEFAULT_NAMES.length);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 2);
  signOut(db);
  assertRelaunches(t);
});

for (const backup of [true, false]) {
  test(`an unknown legacy note owner is proved before recovery (backup: ${backup})`, async (t) => {
    resetBrowserGlobals();
    const db = createDb(t);
    if (!db) return;
    const cloudA = accountCloud("account-a", { serverDefaults: true });
    const cloudB = accountCloud("account-b", { serverDefaults: true });
    // A used an older build, leaving a cloud-linked note and folder without attribution.
    db.setActiveAccountId("account-a");
    signOut(db);
    const local = db.saveNote("Unattributed A note", "only A owns this", "meeting").note;
    const remote = cloudA.seedNote({
      client_note_id: local.client_note_id,
      title: local.title,
      content: local.content,
      folder_id: cloudFolderId(cloudA, "Meetings"),
      created_at: "2026-01-02T00:00:00.000Z",
    });
    const cloudFolder = cloudA.folders().find((folder) => folder.name === "Meetings");
    bindLegacyFolder(db, "Meetings", cloudFolder, "legacy-local-meetings");
    db.db
      .prepare("UPDATE notes SET cloud_id = ?, sync_status = 'synced' WHERE id = ?")
      .run(remote.id, local.id);
    db._repairCloudBoundLegacyRows();
    db._splitPrivateSpaceByAccount();

    await signIn(t, db, "account-b", cloudB, { backup });
    assert.deepEqual(notesFor(db), []);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
    assert.equal(
      db.db.prepare("SELECT account_id FROM notes WHERE id = ?").get(local.id).account_id,
      null
    );
    assert.equal(cloudB.notes().length, 0);
    signOut(db);
    await signIn(t, db, "account-a", cloudA, { backup });
    assert.deepEqual(notesFor(db), [local.title]);
    const recovered = db.getNote(local.id);
    assert.equal(recovered.account_id, "account-a");
    assert.equal(recovered.owner_user_id, "account-a");
    assert.equal(recovered.cloud_id, remote.id);
    assert.equal(recovered.content, local.content);
    assert.equal(recovered.folder_id, folderOf(db, "account-a", "Meetings").id);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS count FROM notes").get().count, 1);
    assert.equal(cloudA.notes().length, 1);
    assert.equal(cloudA.folders().length, DEFAULT_NAMES.length);
    signOut(db);
    assertRelaunches(t);
  });
}

test("a second account older than the device's last pull still gets its own rows", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  await signIn(t, db, "account-a", cloudA);
  db.saveNote("A note", "a", "personal");
  await sync(t);
  signOut(db);

  // Everything in B's cloud predates the cursor A's passes advanced.
  const cloudB = accountCloud("account-b", { serverDefaults: true });
  cloudB.seedNote({
    client_note_id: "b-old-note",
    title: "B old note",
    content: "b",
    folder_id: cloudFolderId(cloudB, "Personal"),
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  });
  await signIn(t, db, "account-b", cloudB);

  assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
  assert.deepEqual(notesFor(db), ["B old note"]);
  assert.equal(
    db.db.prepare("SELECT folder_id FROM notes WHERE title = 'B old note'").get().folder_id,
    folderOf(db, "account-b", "Personal").id
  );
  assert.equal(
    cloudB.folders().length,
    DEFAULT_NAMES.length,
    "B adopts its cloud defaults instead of pushing more"
  );

  // Each account's delta resumes from its own last pull, so a delete made
  // elsewhere while A was signed in still reaches B.
  signOut(db);
  await signIn(t, db, "account-a", cloudA);
  assert.deepEqual(notesFor(db), ["A note"]);
  signOut(db);
  await cloudB.request({
    method: "DELETE",
    path: "/api/notes/delete",
    body: { id: cloudNote(cloudB, "B old note").id },
  });
  await signIn(t, db, "account-b", cloudB);
  assert.deepEqual(notesFor(db), []);
  assertRelaunches(t);
});

// The pre-fix shape on one account: a device-owned folder bound to the
// account's cloud folder. Older builds kept the local client id, so it can
// differ from the cloud's.
function bindLegacyFolder(db, name, cloudFolder, clientFolderId) {
  db.db
    .prepare(
      `UPDATE folders SET cloud_id = ?, client_folder_id = ?, sync_status = 'synced', updated_at = ?
       WHERE name = ? AND account_id IS NULL`
    )
    .run(cloudFolder.id, clientFolderId, cloudFolder.updated_at, name);
}

test("an unpushed device note stays separate while accounts use their own defaults", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  await signIn(t, db, "account-a", cloudA);
  signOut(db);
  const guest = db.saveNote("Device meeting", "unpublished", "meeting").note;
  const guestFolder = folderOf(db, null, "Meetings");
  const cloudB = accountCloud("account-b", { serverDefaults: true });
  await signIn(t, db, "account-b", cloudB);
  assert.deepEqual(notesFor(db), []);
  assert.equal(cloudB.notes().length, 0);
  assert.deepEqual(
    db.getDeviceNotes().notes.map((note) => note.id),
    [guest.id]
  );
  const untouched = db.db.prepare("SELECT * FROM notes WHERE id = ?").get(guest.id);
  assert.equal(untouched.account_id, null);
  assert.equal(untouched.cloud_id, null);
  assert.equal(untouched.folder_id, guestFolder.id);
  const own = db.saveNote("B meeting", "b", "meeting").note;
  await sync(t);
  assert.equal(db.getNote(own.id).folder_id, folderOf(db, "account-b", "Meetings").id);
  assert.equal(cloudNote(cloudB, "B meeting").folder_id, cloudFolderId(cloudB, "Meetings"));
  signOut(db);
  assert.deepEqual(notesFor(db), ["Device meeting"]);
  await signIn(t, db, "account-a", cloudA);
  assert.deepEqual(notesFor(db), []);
  assert.equal(cloudA.notes().length, 0);
});

test("an upgraded account recovers one visible copy of its legacy folder, whatever its client id", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  const work = cloudA.seedFolder({
    client_folder_id: "server-work",
    name: "Work",
    is_default: false,
    sort_order: 3,
    created_at: "2026-01-01T00:00:00.000Z",
  });
  db.setActiveAccountId(null);
  db.createFolder("Work");
  bindLegacyFolder(db, "Work", work, "legacy-local-work");

  await signIn(t, db, "account-a", cloudA);

  const works = db.getFolders().filter((folder) => folder.name === "Work");
  assert.equal(works.length, 1);
  assert.equal(works[0].account_id, "account-a");
  assert.equal(works[0].cloud_id, work.id);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
  assert.equal(cloudA.folders().length, DEFAULT_NAMES.length + 1, "nothing is pushed twice");
  assertRelaunches(t);
});

test("another account's unclaimed legacy default never stands in for a new account's own", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  const meetingsA = cloudA.folders().find((folder) => folder.name === "Meetings");
  bindLegacyFolder(db, "Meetings", meetingsA, meetingsA.client_folder_id);
  const legacyId = folderOf(db, null, "Meetings").id;
  const cloudB = accountCloud("account-b", { serverDefaults: false });
  await signIn(t, db, "account-b", cloudB);
  const meetingsB = folderOf(db, "account-b", "Meetings");
  assert.ok(meetingsB);
  assert.notEqual(meetingsB.id, legacyId);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
  const note = db.saveNote("B meeting", "b", "meeting").note;
  await sync(t);
  assert.equal(cloudNote(cloudB, "B meeting").folder_id, cloudFolderId(cloudB, "Meetings"));
  assert.equal(db.getNote(note.id).sync_status, "synced");
  assert.equal(folderOf(db, null, "Meetings").cloud_id, meetingsA.id);

  signOut(db);
  await signIn(t, db, "account-a", cloudA);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
  assert.equal(folderOf(db, "account-a", "Meetings").cloud_id, meetingsA.id);
  assert.equal(db.getFolders().filter((folder) => folder.cloud_id === meetingsA.id).length, 1);
  assert.equal(cloudA.folders().length, DEFAULT_NAMES.length);
  assertRelaunches(t);
});

test("an unowned upgrade cursor cannot hide an older second account's notes", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  await signIn(t, db, "account-a", cloudA);
  assert.equal(browserLocalStorage.getItem("lastSyncedAt.accountId"), "account-a");
  browserLocalStorage.removeItem("lastSyncedAt.accountId");
  signOut(db);
  const cloudB = accountCloud("account-b", { serverDefaults: true });
  cloudB.seedNote({
    client_note_id: "old-b-note",
    title: "B old note",
    content: "b",
    folder_id: cloudFolderId(cloudB, "Personal"),
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  });
  await signIn(t, db, "account-b", cloudB);
  assert.deepEqual(notesFor(db), ["B old note"]);
});

test("replaying an unowned upgrade cursor still applies remote tombstones", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });
  await signIn(t, db, "account-a", cloudA);
  db.saveNote("Deleted elsewhere", "a", "personal");
  await sync(t);
  await cloudA.request({
    method: "DELETE",
    path: "/api/notes/delete",
    body: { id: cloudNote(cloudA, "Deleted elsewhere").id },
  });
  assert.equal(browserLocalStorage.getItem("lastSyncedAt.accountId"), "account-a");
  browserLocalStorage.removeItem("lastSyncedAt.accountId");
  // An unattributed cursor may have advanced under another account after the delete.
  browserLocalStorage.setItem(
    "lastSyncedAt.notes",
    new Date(Date.parse(cloudNote(cloudA, "Deleted elsewhere").updated_at) + 1).toISOString()
  );
  await sync(t);
  assert.deepEqual(notesFor(db), []);
});

test("replaying an unowned upgrade folder cursor still applies remote tombstones", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloud = accountCloud("account-a", { serverDefaults: true });
  await signIn(t, db, "account-a", cloud);
  const folder = db.createFolder("Work").folder;
  await sync(t);
  const remote = cloud.folders().find((entry) => entry.name === "Work");
  await cloud.request({ method: "DELETE", path: "/api/folders/delete", body: { id: remote.id } });
  assert.equal(browserLocalStorage.getItem("lastSyncedAt.accountId"), "account-a");
  browserLocalStorage.removeItem("lastSyncedAt.accountId");
  const tombstone = cloud.folders().find((entry) => entry.id === remote.id);
  browserLocalStorage.setItem(
    "lastSyncedAt.folders",
    new Date(Date.parse(tombstone.updated_at) + 1).toISOString()
  );
  await sync(t);
  assert.equal(
    db.getFolders().some((entry) => entry.id === folder.id),
    false
  );
  assert.equal(db.getFolderByCloudId(remote.id), null);
});

for (const kind of ["folder", "note"]) {
  test(`a queued ${kind} create acknowledgement cannot bind the outgoing row to the incoming account`, async (t) => {
    resetBrowserGlobals();
    const db = createDb(t);
    if (!db) return;
    const cloudA = accountCloud("account-a", { serverDefaults: true });
    let rowId;
    if (kind === "folder") {
      rowId = db.createFolder("Guest work").folder.id;
    } else {
      rowId = db.saveNote("Guest root note", "guest", "personal").note.id;
      db.db.prepare("UPDATE notes SET folder_id = NULL WHERE id = ?").run(rowId);
    }
    db.setActiveAccountId("account-a");
    db.claimSignedOutPrivateNotes();
    db.ensureAccountDefaultFolders();
    if (kind === "folder") {
      const row = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(rowId);
      db.db
        .prepare("UPDATE folders SET space_id = ?, account_id = ? WHERE id = ?")
        .run(db.getPrivateSpaceId(), "account-a", row.id);
    }
    browserWindow.electronAPI = createElectronApi(db, { cloud: cloudA });
    enableSync();
    await establishValidatedAuth("account-a");
    const operation = kind === "folder" ? "acknowledgeFolderCreate" : "acknowledgeNoteCreate";
    const acknowledge = browserWindow.electronAPI[operation];
    let interrupted = false;
    browserWindow.electronAPI[operation] = async (...args) => {
      if (args[0] === rowId) {
        interrupted = true;
        const { invalidateValidatedAuthContext } =
          await import("../../src/lib/authRequestContext.ts");
        invalidateValidatedAuthContext();
        browserWindow.electronAPI.cloudApiRequest = async () => ({
          success: false,
          code: "AUTH_CONTEXT_CHANGED",
          error: "Authentication context changed during request",
        });
        db.setActiveAccountId("account-b");
        db.ensureAccountDefaultFolders();
      }
      return acknowledge(...args);
    };
    const { SyncService } = await loadSync();
    const service = new SyncService();
    t.after(() => stopSyncTimers(service));
    await service.syncAll(true);
    assert.equal(interrupted, true);
    const row = db.db
      .prepare(`SELECT * FROM ${kind === "folder" ? "folders" : "notes"} WHERE id = ?`)
      .get(rowId);
    assert.equal(row.account_id, "account-a");
    assert.equal(row.cloud_id, null);
  });
}

for (const operation of ["markFolderSyncedIfUnchanged", "ensureAccountDefaultFolders"]) {
  test(`queued ${operation} does not apply a departing account's ownership evidence`, async (t) => {
    resetBrowserGlobals();
    const db = createDb(t);
    if (!db) return;
    const ownFolder = operation === "markFolderSyncedIfUnchanged";
    const outgoingAccount = ownFolder ? "account-a" : "account-b";
    const incomingAccount = ownFolder ? "account-b" : "account-a";
    const cloudA = accountCloud("account-a", { serverDefaults: true });
    const outgoingCloud = ownFolder ? cloudA : accountCloud("account-b", { serverDefaults: true });
    db.setActiveAccountId(outgoingAccount);
    db.ensureAccountDefaultFolders();
    const folder = folderOf(db, outgoingAccount, "Meetings");
    // A legacy bound folder left inside a private space before attribution.
    db.db
      .prepare(
        "UPDATE folders SET account_id = NULL, cloud_id = ?, sync_status = 'synced' WHERE id = ?"
      )
      .run(cloudFolderId(cloudA, "Meetings"), folder.id);
    browserWindow.electronAPI = createElectronApi(db, { cloud: outgoingCloud });
    enableSync();
    await establishValidatedAuth(outgoingAccount);
    const original = browserWindow.electronAPI[operation];
    let interrupted = false;
    browserWindow.electronAPI[operation] = async (...args) => {
      interrupted = true;
      const { invalidateValidatedAuthContext } =
        await import("../../src/lib/authRequestContext.ts");
      invalidateValidatedAuthContext();
      db.setActiveAccountId(incomingAccount);
      db.ensureAccountDefaultFolders();
      return original(...args);
    };
    const { SyncService } = await loadSync();
    const service = new SyncService();
    t.after(() => stopSyncTimers(service));
    await service.syncAll(true);
    assert.equal(interrupted, true);
    const untouched = db.db.prepare("SELECT * FROM folders WHERE id = ?").get(folder.id);
    assert.equal(untouched.account_id, null);
    assert.equal(untouched.cloud_id, cloudFolderId(cloudA, "Meetings"));

    db.setActiveAccountId(outgoingAccount);
    browserWindow.electronAPI = createElectronApi(db, { cloud: outgoingCloud });
    await establishValidatedAuth(outgoingAccount);
    await service.syncAll(true);
    assert.equal(
      folderOf(db, outgoingAccount, "Meetings").cloud_id,
      cloudFolderId(outgoingCloud, "Meetings")
    );
    assert.equal(db.getFolders().filter((candidate) => candidate.name === "Meetings").length, 1);
  });
}
