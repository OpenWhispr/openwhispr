const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const DatabaseManager = require("../../src/helpers/database.js");
Module._load = originalLoad;

function createSearchDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE transcriptions (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      deleted_at TEXT
    );
  `);

  const insert = sqlite.prepare(
    "INSERT INTO transcriptions (id, text, timestamp, status, deleted_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const [id, text, timestamp, status = "completed", deletedAt = null] of [
    [1, "quarterly revenue forecast", "2026-01-03 10:00:00"],
    [2, "中文测试项目计划", "2026-01-02 10:00:00"],
    [3, "東京駅への旅行計画", "2026-01-01 10:00:00"],
    [4, "discarded quarterly review", "2025-12-31 10:00:00", "discarded"],
    [5, "deleted quarterly review", "2025-12-30 10:00:00", "completed", "2026-01-01"],
  ]) {
    insert.run(id, text, timestamp, status, deletedAt);
  }

  // Populate the external-content index for this isolated search fixture.
  sqlite.exec(`
    CREATE VIRTUAL TABLE transcriptions_fts USING fts5(
      text,
      content='transcriptions',
      content_rowid='id'
    );
  `);
  sqlite.prepare("INSERT INTO transcriptions_fts(transcriptions_fts) VALUES (?)").run("rebuild");

  const manager = Object.create(DatabaseManager.prototype);
  manager.db = sqlite;
  return { manager, sqlite };
}

test("searchTranscriptions uses Notes-style Unicode prefix matching", (t) => {
  const { manager, sqlite } = createSearchDatabase();
  t.after(() => sqlite.close());

  for (const [query, expectedId] of [
    ["quart rev", 1],
    ["中文", 2],
    ["東京", 3],
  ]) {
    assert.equal(manager.searchTranscriptions(query, 20)[0]?.id, expectedId, query);
  }
});

test("searchTranscriptions filters deleted and discarded transcripts by default", (t) => {
  const { manager, sqlite } = createSearchDatabase();
  t.after(() => sqlite.close());

  assert.deepEqual(
    manager.searchTranscriptions("quarterly", 20).map((item) => item.id),
    [1]
  );
  assert.deepEqual(
    manager
      .searchTranscriptions("quarterly", 20, { includeDiscarded: true })
      .map((item) => item.id),
    [1, 4]
  );
});
