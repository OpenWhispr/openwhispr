const test = require("node:test");
const assert = require("node:assert/strict");
const { createDb } = require("../helpers/harness/db.js");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The assistant's scope and create_note against a real database while main's workspace scope
// lags: startup and every account change until the control panel's list answers, and a whole
// session for a launch that never opens the control panel (start minimized, login).

const ACCOUNT = "account-1";

// The account's live Private rows (the signed-out stand-in isn't the account's).
const livePrivateRows = (db) =>
  db.db
    .prepare(
      `SELECT id, workspace_id FROM spaces
       WHERE kind = 'private' AND account_id = ? AND deleted_at IS NULL ORDER BY id`
    )
    .all(ACCOUNT);

const folderNames = (db) =>
  db.db
    .prepare(
      `SELECT f.name FROM folders f JOIN spaces s ON s.id = f.space_id
       WHERE s.kind = 'private' AND s.account_id = ? AND f.deleted_at IS NULL
         AND s.deleted_at IS NULL ORDER BY f.name`
    )
    .all(ACCOUNT)
    .map((row) => row.name);

// The dictation window (no workspace list), over the real database, with `activeWorkspaceId`
// saved as the active workspace.
async function loadAssistant(t, db, activeWorkspaceId) {
  installBrowserGlobals(t, {
    initialStorage: { activeWorkspaceId },
    window: {
      electronAPI: {
        getSpaces: async () => db.getSpaces(),
        getPrivateSpaceId: async (workspaceId = null) => db.getPrivateSpaceId(workspaceId),
        getFolders: async (spaceId = null) => db.getFolders(spaceId),
        createFolder: async (name, spaceId) => db.createFolder(name, spaceId),
        saveNote: async (...args) => db.saveNote(...args),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-assistant-scope-lag-",
    mockModules: { "/SyncService.js": "export const syncService = { debouncedPush() {} };" },
  });
  const { resolveAssistantScopeSpaceIds } = await vite.ssrLoadModule("/lib/assistantNoteScope.ts");
  const { createCreateNoteTool } = await vite.ssrLoadModule("/services/tools/createNoteTool.ts");
  return {
    resolveScope: resolveAssistantScopeSpaceIds,
    createNote: (scope, args) => createCreateNoteTool({ spaceIds: scope }).execute(args),
  };
}

// Main as it opens after an account change: it knows no workspace yet.
function lagging(db) {
  db.setActiveWorkspaceScope({ activeWorkspaceId: null, defaultWorkspaceId: null });
}

test("first launch after the upgrade, main lagging on the default: the pending Private is read and filed into, and no row is made", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(ACCOUNT);
  lagging(db);
  const pending = db.getPrivateSpaceId();
  const projects = db.createFolder("Projects", pending).folder;
  db.saveNote("Old project note", "Roadmap", "personal", null, null, projects.id, pending);
  // D is the default, saved as active, but nothing on this side knows it is the default yet.
  const { resolveScope, createNote } = await loadAssistant(t, db, "workspace-d");
  const rowsBefore = livePrivateRows(db);

  const scope = await resolveScope();
  assert.deepEqual(scope, [pending]);

  const created = await createNote(scope, {
    title: "Assistant note",
    content: "Follow-ups",
    folder: "Projects",
  });
  assert.equal(created.success, true);
  const note = db.getNote(created.data.id);
  assert.equal(note.space_id, pending);
  assert.equal(note.folder_id, projects.id, "the user's own Projects folder");
  assert.deepEqual(livePrivateRows(db), rowsBefore, "no Private was made for D");

  // The list answers: D is the default, and main binds the pending row to it.
  db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-d",
    defaultWorkspaceId: "workspace-d",
  });
  db.bindDefaultPrivateSpace("workspace-d");
  assert.deepEqual(livePrivateRows(db), [{ id: pending, workspace_id: "workspace-d" }]);
  assert.ok(
    !folderNames(db).some((name) => /\(\d+\)$/.test(name)),
    `no folder renamed: ${folderNames(db).join(", ")}`
  );
});

test("default bound and active, main lagging: the scope is the bound row, and no row is made", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(ACCOUNT);
  db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-d",
    defaultWorkspaceId: "workspace-d",
  });
  db.getSpaces();
  db.bindDefaultPrivateSpace("workspace-d");
  const bound = db.getDefaultPrivateSpaceId();
  lagging(db);
  const { resolveScope, createNote } = await loadAssistant(t, db, "workspace-d");
  const rowsBefore = livePrivateRows(db);

  const scope = await resolveScope();
  assert.deepEqual(scope, [bound]);
  const created = await createNote(scope, { title: "Assistant note", content: "Follow-ups" });
  assert.equal(db.getNote(created.data.id).space_id, bound);
  assert.deepEqual(livePrivateRows(db), rowsBefore);
});

test("a workspace known not to be the default, with no Private yet: create_note makes its row and files there", async (t) => {
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId(ACCOUNT);
  db.setActiveWorkspaceScope({
    activeWorkspaceId: "workspace-d",
    defaultWorkspaceId: "workspace-d",
  });
  db.getSpaces();
  db.bindDefaultPrivateSpace("workspace-d");
  const bound = db.getDefaultPrivateSpaceId();
  lagging(db);
  // The row main bound says D is the default, so workspace A is not.
  const { resolveScope, createNote } = await loadAssistant(t, db, "workspace-a");

  const scope = await resolveScope();
  assert.deepEqual(scope, [], "nothing of D's, and A has no Private yet");
  const created = await createNote(scope, { title: "Assistant note", content: "Follow-ups" });
  assert.equal(created.success, true);
  const ownRow = livePrivateRows(db).find((row) => row.workspace_id === "workspace-a");
  assert.ok(ownRow, "A's Private was made");
  assert.notEqual(ownRow.id, bound);
  assert.equal(db.getNote(created.data.id).space_id, ownRow.id);
  // The next turn reads it.
  assert.deepEqual(await resolveScope(), [ownRow.id]);
});
