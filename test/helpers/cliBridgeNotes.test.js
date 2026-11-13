const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./windowBroadcast") {
    return { broadcastToWindows() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { createDb } = require("./harness/db.js");
const CliBridge = require("../../src/helpers/cliBridge.js");
const { call } = require("./harness/cliBridge.js");
const debugLogger = require("../../src/helpers/debugLogger");

function createBridge(t) {
  const db = createDb(t);
  if (!db) return null;

  const bridge = new CliBridge({
    databaseManager: db,
    notifyVectorChanges() {},
    _asyncMirrorWrite() {},
  });
  return { bridge, db };
}

test("PATCH /v1/notes/:id is not_found when the note does not exist", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "PATCH", "/v1/notes/999", { title: "New Title" }), {
    code: "NOT_FOUND",
  });
});

test("PATCH /v1/notes/:id is not_found for a deleted note and leaves it unchanged", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "content").note;
  ctx.db.markNoteSynced(id, "cloud-note-deleted");
  ctx.db.deleteNote(id);

  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { title: "Edited" }), {
    code: "NOT_FOUND",
  });
  assert.equal(ctx.db.getNote(id).title, "Original");
});

test("PATCH /v1/notes/:id is a validation error when the folder does not exist", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "content").note;

  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { folder_id: 888 }), {
    code: "VALIDATION",
    message: "Folder not found",
  });
});

// Sync owns a note's space, identity and state: a move between spaces re-keys it or refuses it
// (D31, D39), which a raw cloud_id or client_note_id from a local caller would get around. As
// the cloud v1 PATCH does with keys it doesn't take, those fields are dropped (D44), so a CLI
// that sends back the whole row it read still saves its edit.
test("PATCH /v1/notes/:id takes back a whole row from GET and changes only its content fields", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;
  const logged = [];
  const originalDebug = debugLogger.debug;
  debugLogger.debug = (message, meta, scope, ...rest) => {
    if (scope === "cli-bridge") logged.push({ message, meta });
    return originalDebug.call(debugLogger, message, meta, scope, ...rest);
  };
  t.after(() => {
    debugLogger.debug = originalDebug;
  });

  const folder = ctx.db.createFolder("Ideas").folder;
  const { id } = ctx.db.saveNote("Original", "content", "personal", null, null, folder.id).note;
  const before = call(ctx.bridge, "GET", `/v1/notes/${id}`).data;

  const result = call(ctx.bridge, "PATCH", `/v1/notes/${id}`, {
    ...before,
    title: "Edited",
    content: "new body",
    cloud_id: "forged-cloud-id",
    client_note_id: "forged-client-id",
    account_id: "someone-else",
    left_team: 1,
    deleted_at: "2026-01-01 00:00:00",
  });

  assert.equal(result.data.title, "Edited");
  assert.equal(result.data.content, "new body");
  const after = ctx.db.getNote(id);
  for (const field of [
    "space_id",
    "folder_id",
    "cloud_id",
    "client_note_id",
    "account_id",
    "left_team",
    "deleted_at",
  ]) {
    assert.deepEqual(after[field], before[field], field);
  }
  const dropped = logged.find((entry) => Array.isArray(entry.meta?.fields));
  assert.ok(dropped, "the dropped fields are logged");
  for (const field of ["space_id", "cloud_id", "client_note_id", "account_id", "deleted_at"]) {
    assert.ok(dropped.meta.fields.includes(field), field);
  }
});

// A move between spaces goes through folder_id and main's move rules; a space_id that names
// another space is refused rather than silently ignored.
test("PATCH /v1/notes/:id refuses a space_id other than the note's own and changes nothing", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const before = ctx.db.saveNote("Original", "content").note;
  for (const spaceId of [before.space_id + 1, null]) {
    assert.throws(
      () =>
        call(ctx.bridge, "PATCH", `/v1/notes/${before.id}`, { title: "Edited", space_id: spaceId }),
      { code: "VALIDATION", message: /space_id/ },
      String(spaceId)
    );
  }
  const after = ctx.db.getNote(before.id);
  assert.equal(after.title, "Original");
  assert.equal(after.space_id, before.space_id);
});

test("PATCH /v1/notes/:id changes the title, content, summary and folder", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "content").note;
  const folder = ctx.db.createFolder("Ideas").folder;
  const result = call(ctx.bridge, "PATCH", `/v1/notes/${id}`, {
    title: "New",
    content: "new body",
    enhanced_content: "summary",
    folder_id: folder.id,
  });
  assert.equal(result.data.title, "New");
  assert.equal(result.data.content, "new body");
  assert.equal(result.data.enhanced_content, "summary");
  assert.equal(result.data.folder_id, folder.id);
});

test("PATCH /v1/notes/:id is not_found for a non-integer id", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  assert.throws(() => call(ctx.bridge, "PATCH", "/v1/notes/invalid-id", { title: "New Title" }), {
    code: "NOT_FOUND",
    message: "Invalid note id",
  });
});

test("PATCH /v1/notes/:id returns the updated note", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "Existing content").note;
  const result = call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { title: "Updated Title" });

  assert.equal(result.data.id, id);
  assert.equal(result.data.title, "Updated Title");
  assert.equal(result.data.content, "Existing content");
});

test("PATCH /v1/notes/:id clears a provided blank text field so the clear syncs", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "Existing content").note;
  ctx.db.updateNote(id, { enhanced_content: "Summary", transcript: "Spoken words" });

  const result = call(ctx.bridge, "PATCH", `/v1/notes/${id}`, {
    content: "",
    enhanced_content: null,
    transcript: "",
  });

  assert.equal(result.data.content, "");
  assert.equal(result.data.content_sync_operation, "clear");
  assert.equal(result.data.enhanced_content, null);
  assert.equal(result.data.enhanced_content_sync_operation, "clear");
  // Transcript is never a clear target; the bridge stores it as before.
  assert.equal(result.data.transcript, "");
  assert.throws(
    () => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { content: "", clear_fields: "content" }),
    { code: "VALIDATION" }
  );
});

test("PATCH refuses a folder in another workspace", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;
  const { db, bridge } = ctx;
  db.setActiveAccountId("test-account");
  db.setActiveWorkspaceScope({ activeWorkspaceId: "one", defaultWorkspaceId: "one" });
  db.bindDefaultPrivateSpace("one");
  const note = db.saveNote("Private", "body").note;
  const team = Number(
    db.db
      .prepare(
        "INSERT INTO spaces (client_space_id, kind, name, workspace_id) VALUES (?, 'team', ?, ?)"
      )
      .run("cli-team", "Other team", "two").lastInsertRowid
  );
  db.db
    .prepare("INSERT INTO space_accounts (space_id, account_id) VALUES (?, ?)")
    .run(team, "test-account");
  const folder = db.createFolder("Other folder", team).folder;
  assert.throws(() => call(bridge, "PATCH", `/v1/notes/${note.id}`, { folder_id: folder.id }), {
    code: "VALIDATION",
    message: "Cannot move between workspaces",
  });
  assert.equal(db.getNote(note.id).space_id, note.space_id);
});
