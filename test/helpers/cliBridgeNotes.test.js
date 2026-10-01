const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-notes-"));
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
  if (request === "./windowBroadcast") {
    return { broadcastToWindows() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");
const CliBridge = require("../../src/helpers/cliBridge.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createBridge(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-notes-"));
  let db;
  try {
    const BetterSqlite = require("better-sqlite3");
    const probe = new BetterSqlite(path.join(userDataDir, "probe.db"));
    probe.close();
    fs.rmSync(path.join(userDataDir, "probe.db"), { force: true });
    db = new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }

  const bridge = new CliBridge({
    databaseManager: db,
    notifyVectorChanges() {},
    _asyncMirrorWrite() {},
  });
  return { bridge, db };
}

function call(bridge, method, pathname, body) {
  for (const route of bridge.routes) {
    if (route.method !== method) continue;
    const params = route.match(pathname);
    if (!params) continue;
    return route.handler({ params, query: new URLSearchParams(), body });
  }
  throw new Error(`No route for ${method} ${pathname}`);
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
