const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  establishValidatedAuth,
  enableSync,
  stopSyncTimers,
  localStorage,
  window,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");
const { SyncService } = require("../../src/services/SyncService.ts");

const PRIVATE_NOTE = {
  id: "cloud-a",
  client_note_id: "client-note",
  title: "Account A private note",
  content: "Account A private draft",
  note_type: "personal",
  folder_id: null,
  space_id: null,
  user_id: "account-a",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  revision: 1,
};

const collisions = [
  { name: "another account", accountId: "account-b", cloudId: "cloud-a" },
  { name: "another cloud identity", accountId: "account-a", cloudId: "cloud-b" },
  { name: "another account and cloud identity", accountId: "account-b", cloudId: "cloud-b" },
];

function collidingCloudNote({ accountId, cloudId }) {
  return {
    ...PRIVATE_NOTE,
    id: cloudId,
    user_id: accountId,
    content: "Incoming collision text",
    updated_at: "2026-01-02T00:00:00.000Z",
    revision: 2,
  };
}

function seedPrivateNote(db, accountId) {
  db.setActiveAccountId("account-a");
  const row = db.upsertNoteFromCloud(PRIVATE_NOTE, null);
  db.setActiveAccountId(accountId);
  return row;
}

for (const collision of collisions) {
  test(`a client-ID collision with ${collision.name} returns no note`, (t) => {
    const db = createDb(t);
    if (!db) return;
    const row = seedPrivateNote(db, collision.accountId);

    assert.equal(
      db.getNote(row.id)?.id ?? null,
      collision.accountId === "account-a" ? row.id : null
    );
    assert.equal(
      db.getNoteByClientId(row.client_note_id)?.id ?? null,
      collision.accountId === "account-a" ? row.id : null
    );
    const result = db.upsertNoteFromCloud(collidingCloudNote(collision), null);

    assert.deepEqual(db.db.prepare("SELECT * FROM notes WHERE id = ?").get(row.id), row);
    assert.equal(result, null);
  });
}

// Execute the exact production callback; only the native window broadcast is
// replaced. Copying its truthiness guard here would hide the original leak.
function cloudUpsertHandler(db, broadcast, notifyVectorChanges) {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");
  const registration = source.match(
    /ipcMain\.handle\("db-upsert-note-from-cloud", ([\s\S]*?)\n {4}\}\);/
  );
  assert.ok(registration, "the cloud-note IPC callback must be present");
  return new Function("broadcastToWindows", "setImmediate", `return (${registration[1]}\n});`).call(
    { databaseManager: db, notifyVectorChanges },
    broadcast,
    setImmediate
  );
}

// Keep the real Zustand state, listeners, and container routing. The unrelated
// background sync singleton and React UI dependency are inert in this fixture.
function loadNoteStore() {
  const filename = path.join(__dirname, "../../src/stores/noteStore.ts");
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const defaultRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (specifier === "../services/SyncService.js") {
      return { syncService: { setNoteOpen() {}, requestSyncAll() {}, debouncedPush() {} } };
    }
    if (specifier === "../components/notes/shared") return { findDefaultFolder: () => null };
    return defaultRequire(specifier);
  };
  loaded._compile(compiled, filename);
  return loaded.exports;
}

for (const collision of collisions) {
  test(`a pull skips ${collision.name} at IPC and renderer while the next note arrives`, async (t) => {
    const db = createDb(t);
    if (!db) return;
    const protectedRow = seedPrivateNote(db, collision.accountId);
    const validCloudNote = {
      ...PRIVATE_NOTE,
      id: "valid-cloud-note",
      client_note_id: "valid-client-note",
      title: "Valid following note",
      content: "Visible to the active account",
      user_id: collision.accountId,
    };
    const fallback = createFakeCloud();
    const cloud = {
      request: async (options) =>
        options.path.startsWith("/api/notes/list")
          ? { success: true, data: { notes: [collidingCloudNote(collision), validCloudNote] } }
          : fallback.request(options),
    };
    resetBrowserGlobals();
    installBrowserGlobals();
    enableSync();
    const events = [];
    const results = [];
    let onNoteSynced;
    let vectorChanges = 0;
    const handler = cloudUpsertHandler(
      db,
      (channel, note) => {
        events.push([channel, note.id]);
        if (channel === "note-synced") onNoteSynced(note);
      },
      () => vectorChanges++
    );
    window.electronAPI = {
      ...createElectronApi(db, { cloud }),
      getNotes: async (...args) => db.getNotes(...args),
      getFolderNoteCounts: async () => db.getFolderNoteCounts(),
      onNoteSynced: (callback) => {
        onNoteSynced = callback;
        return () => {};
      },
      upsertNoteFromCloud: async (...args) => {
        const result = handler(null, ...args);
        results.push(result?.id ?? null);
        return result;
      },
    };
    await establishValidatedAuth(collision.accountId);
    const service = new SyncService();
    t.after(() => {
      stopSyncTimers(service);
      resetBrowserGlobals();
    });
    const store = loadNoteStore();
    const privateSpaceId = db.getPrivateSpaceId();
    await store.initializeNotes();
    await store.loadSpaces();
    await store.loadContainerNotes(store.spaceContainerKey(privateSpaceId));
    for (const folder of await store.loadFolders()) {
      await store.loadContainerNotes(store.folderContainerKey(folder.id));
    }
    store.setActiveContext(privateSpaceId, null);
    const expectedProtectedId = collision.accountId === "account-a" ? protectedRow.id : null;
    assert.equal(store.getNoteFromStore(protectedRow.id)?.id ?? null, expectedProtectedId);

    const complete = await service.pullNotes();
    await new Promise(setImmediate);
    const accepted = db.getNoteByClientId(validCloudNote.client_note_id);
    assert.ok(accepted, "the valid row after the collision must persist");
    assert.equal(accepted.account_id, collision.accountId);
    assert.equal(accepted.content, "Visible to the active account");
    assert.deepEqual(
      {
        complete,
        results,
        events,
        vectorChanges,
        protectedRendererId: store.getNoteFromStore(protectedRow.id)?.id ?? null,
        validRendererContent: store.getNoteFromStore(accepted.id)?.content ?? null,
      },
      {
        complete: true,
        results: [null, accepted.id],
        events: [["note-synced", accepted.id]],
        vectorChanges: 1,
        protectedRendererId: expectedProtectedId,
        validRendererContent: "Visible to the active account",
      }
    );
    assert.ok(
      localStorage.getItem("lastSyncedAt.notes"),
      "a skipped collision must not stall the cursor"
    );
    assert.deepEqual(
      db.db.prepare("SELECT * FROM notes WHERE id = ?").get(protectedRow.id),
      protectedRow
    );
  });
}

test("cloud pulls still adopt an unattributed note and move it between private and team spaces", (t) => {
  const db = createDb(t);
  if (!db) return;
  const original = db.saveNote("Signed-out note", "Original local text").note;
  assert.equal(original.account_id, null);
  assert.equal(original.cloud_id, null);
  db.setActiveAccountId("account-a");
  const cloudNote = { ...PRIVATE_NOTE, client_note_id: original.client_note_id };
  const adopted = db.upsertNoteFromCloud(cloudNote, null);
  assert.equal(adopted.id, original.id);
  assert.equal(adopted.account_id, "account-a");
  assert.equal(adopted.cloud_id, "cloud-a");
  assert.equal(adopted.content, "Account A private draft");

  const team = db.upsertSpaceFromCloud({ id: "cloud-team", name: "Team" });
  const teamNote = db.upsertNoteFromCloud(
    { ...cloudNote, space_id: "cloud-team", content: "Team copy", revision: 2 },
    null,
    team.id
  );
  assert.equal(teamNote.id, original.id);
  assert.equal(teamNote.space_id, team.id);
  assert.equal(teamNote.account_id, null);
  assert.equal(db.getNote(original.id).content, "Team copy");
  db.setActiveAccountId("account-b");
  assert.equal(db.getNote(original.id), null);
  db.setActiveAccountId("account-a");

  const privateNote = db.upsertNoteFromCloud(
    { ...cloudNote, content: "Private again", revision: 3 },
    null,
    db.getPrivateSpaceId()
  );
  assert.equal(privateNote.id, original.id);
  assert.equal(privateNote.space_id, db.getPrivateSpaceId());
  assert.equal(privateNote.account_id, "account-a");
  assert.equal(db.getNote(original.id).content, "Private again");
  db.setActiveAccountId("account-b");
  assert.equal(db.getNote(original.id), null);
});
