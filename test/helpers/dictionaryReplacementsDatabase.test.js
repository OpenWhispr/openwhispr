const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-repl-db-"));
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

// Both halves are needed: the first load in a process reports NODE_MODULE_VERSION,
// every later one reports "did not self-register" with ERR_DLOPEN_FAILED.
function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file") ||
    message.includes("did not self-register") ||
    error?.code === "ERR_DLOPEN_FAILED"
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-repl-db-"));
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

test("set and get round-trip preserves order and content", (t) => {
  const db = createDb(t);
  if (!db) return;

  const rules = [
    { from: "wheels", to: "views" },
    { from: "git hub", to: "GitHub" },
    { from: "a p i", to: "API" },
  ];
  const result = db.setDictionaryReplacements(rules);
  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.deepEqual(db.getDictionaryReplacements(), rules);
});

test("set replaces the whole list", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionaryReplacements([
    { from: "wheels", to: "views" },
    { from: "kubernets", to: "Kubernetes" },
  ]);
  db.setDictionaryReplacements([{ from: "wheels", to: "views" }]);
  assert.deepEqual(db.getDictionaryReplacements(), [{ from: "wheels", to: "views" }]);
});

test("case-variant sources collapse to one row, first wins", (t) => {
  const db = createDb(t);
  if (!db) return;

  const result = db.setDictionaryReplacements([
    { from: "wheels", to: "views" },
    { from: "Wheels", to: "tyres" },
  ]);
  assert.equal(result.count, 1);
  assert.deepEqual(db.getDictionaryReplacements(), [{ from: "wheels", to: "views" }]);
});

test("entries are trimmed and inner whitespace collapses", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionaryReplacements([{ from: "  git   hub  ", to: "  GitHub  " }]);
  assert.deepEqual(db.getDictionaryReplacements(), [{ from: "git hub", to: "GitHub" }]);
});

test("invalid entries are dropped instead of failing the write", (t) => {
  const db = createDb(t);
  if (!db) return;

  const result = db.setDictionaryReplacements([
    { from: "", to: "x" },
    { from: "x", to: "" },
    { from: 42, to: "x" },
    null,
    { from: "a".repeat(121), to: "x" },
    { from: "ok", to: "y".repeat(241) },
    { from: "wheels", to: "views" },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.count, 1);
  assert.deepEqual(db.getDictionaryReplacements(), [{ from: "wheels", to: "views" }]);
});

test("non-array input reports failure without touching stored rules", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionaryReplacements([{ from: "wheels", to: "views" }]);
  const result = db.setDictionaryReplacements("wheels=views");
  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.deepEqual(db.getDictionaryReplacements(), [{ from: "wheels", to: "views" }]);
});

test("an empty list clears every rule", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setDictionaryReplacements([{ from: "wheels", to: "views" }]);
  const result = db.setDictionaryReplacements([]);
  assert.equal(result.success, true);
  assert.equal(result.count, 0);
  assert.deepEqual(db.getDictionaryReplacements(), []);
});

test("a fresh database starts with no rules", (t) => {
  const db = createDb(t);
  if (!db) return;

  assert.deepEqual(db.getDictionaryReplacements(), []);
});
