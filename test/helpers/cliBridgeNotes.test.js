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
  ctx.db.deleteNote(id);

  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { title: "Edited" }), {
    code: "NOT_FOUND",
  });
  assert.equal(ctx.db.getNote(id).title, "Original");
});

test("PATCH /v1/notes/:id is a validation error when the folder or space does not exist", (t) => {
  const ctx = createBridge(t);
  if (!ctx) return;

  const { id } = ctx.db.saveNote("Original", "content").note;

  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { folder_id: 888 }), {
    code: "VALIDATION",
    message: "Folder not found",
  });
  assert.throws(() => call(ctx.bridge, "PATCH", `/v1/notes/${id}`, { space_id: 888 }), {
    code: "VALIDATION",
    message: "Space not found",
  });
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
