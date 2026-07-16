const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-translation-db-"));
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

// The repo's better-sqlite3 binding is built for Electron's ABI, so a plain `node`
// runtime cannot dlopen it. Skip cleanly instead of failing in that case.
function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file") ||
    message.includes("ERR_DLOPEN_FAILED") ||
    error?.code === "ERR_DLOPEN_FAILED"
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-translation-db-"));
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

function findById(rows, id) {
  return rows.find((row) => row.id === id) || null;
}

test("saveTranscription with routeKind translation round-trips route_kind", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { id } = db.saveTranscription("Ciao", "Hello", { routeKind: "translation" });
  const row = findById(db.getTranscriptions(), id);

  assert.ok(row);
  assert.equal(row.route_kind, "translation");
});

test("saveTranscription without routeKind stores route_kind null", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { id } = db.saveTranscription("plain text");
  const row = findById(db.getTranscriptions(), id);

  assert.ok(row);
  assert.equal(row.route_kind, null);
});

test("discarded save keeps its routeKind", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { id } = db.saveTranscription("", "Hello", {
    status: "discarded",
    routeKind: "translation",
  });

  // Discarded rows are filtered out of the default listing.
  assert.equal(findById(db.getTranscriptions(), id), null);

  const row = findById(db.getTranscriptions(50, { includeDiscarded: true }), id);
  assert.ok(row);
  assert.equal(row.status, "discarded");
  assert.equal(row.route_kind, "translation");
});

test("updateTranscriptionText does not clobber route_kind", (t) => {
  const db = createDb(t);
  if (!db) return;

  const { id } = db.saveTranscription("Ciao", "Hello", { routeKind: "translation" });
  db.updateTranscriptionText(id, "Salve", "Hello");

  const row = findById(db.getTranscriptions(), id);
  assert.ok(row);
  assert.equal(row.text, "Salve");
  assert.equal(row.raw_text, "Hello");
  assert.equal(row.route_kind, "translation");
});
