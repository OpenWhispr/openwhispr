const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isNativeBindingUnavailable,
  describeBindingFailure,
  requireSqlite,
} = require("../support/sqlite.js");

test("isNativeBindingUnavailable recognizes an ABI mismatch", () => {
  const error = new Error(
    "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 133."
  );
  assert.equal(isNativeBindingUnavailable(error), true);
});

test("isNativeBindingUnavailable recognizes a missing binding", () => {
  const error = new Error("Could not locate the bindings file. Tried: ...");
  assert.equal(isNativeBindingUnavailable(error), true);
});

test("isNativeBindingUnavailable ignores unrelated errors", () => {
  assert.equal(isNativeBindingUnavailable(new Error("no such table: notes")), false);
  assert.equal(isNativeBindingUnavailable(null), false);
});

test("describeBindingFailure names the remediation and keeps the original error", () => {
  const message = describeBindingFailure(new Error("NODE_MODULE_VERSION 133"));
  assert.match(message, /npm rebuild better-sqlite3/);
  assert.match(message, /electron-builder install-app-deps/);
  assert.match(message, /NODE_MODULE_VERSION 133/);
});

test("requireSqlite returns a usable driver instead of skipping", () => {
  const Database = requireSqlite();
  const db = new Database(":memory:");
  db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
  db.prepare("INSERT INTO probe (id) VALUES (?)").run(1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM probe").get().n, 1);
  db.close();
});
