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
const { buildNoteSearchQuery } = require("../../src/helpers/noteSearch.js");

test("buildNoteSearchQuery builds quoted prefix queries", () => {
  for (const [input, expected] of [
    ["hello", '"hello"*'],
    ["hello world", '"hello"* "world"*'],
    ["Привет мир", '"Привет"* "мир"*'],
    ["中文", '"中文"*'],
    ["東京", '"東京"*'],
    ["مرحبا", '"مرحبا"*'],
    ["café", '"café"*'],
    ["cafe\u0301", '"café"*'],
    ["2026", '"2026"*'],
    ["résumé 2026", '"résumé"* "2026"*'],
    ["  naïve  ", '"naïve"*'],
    ["hello,world", '"hello"* "world"*'],
    ["foo_bar", '"foo_bar"*'],
  ]) {
    assert.equal(buildNoteSearchQuery(input), expected, input);
  }
});

test("buildNoteSearchQuery discards empty input and FTS5 syntax", () => {
  for (const input of ["", "   ", "!!!", "***", '""', "___"]) {
    assert.equal(buildNoteSearchQuery(input), "", input);
  }

  for (const [input, expected] of [
    ["OR", '"OR"*'],
    ["title:", '"title"*'],
    ['foo"bar', '"foo"* "bar"*'],
    ["hello -world", '"hello"* "world"*'],
  ]) {
    assert.equal(buildNoteSearchQuery(input), expected, input);
  }
});

function createSearchDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, content);
  `);

  const insertNote = sqlite.prepare("INSERT INTO notes (title, content) VALUES (?, ?)");
  const insertFts = sqlite.prepare(
    "INSERT INTO notes_fts (rowid, title, content) VALUES (?, ?, ?)"
  );

  for (const [title, content] of [
    ["Привет мир", "Заметка о проекте"],
    ["中文测试", "项目计划"],
    ["مرحبا بالعالم", "ملاحظات المشروع"],
    ["café résumé", "naïve approach"],
    ["hello world", "ordinary ASCII note"],
    ["東京駅", "旅行計画"],
    ["OR operation", "literal operator note"],
  ]) {
    const { lastInsertRowid } = insertNote.run(title, content);
    insertFts.run(lastInsertRowid, title, content);
  }

  const manager = Object.create(DatabaseManager.prototype);
  manager.db = sqlite;
  return { manager, sqlite };
}

test("DatabaseManager.searchNotes matches Unicode and ASCII prefixes with SQLite FTS5", (t) => {
  const { manager, sqlite } = createSearchDatabase();
  t.after(() => sqlite.close());

  for (const [query, expectedTitle] of [
    ["Прив", "Привет мир"],
    ["中文", "中文测试"],
    ["مرح", "مرحبا بالعالم"],
    ["caf rés", "café résumé"],
    ["hel wor", "hello world"],
    ["東京", "東京駅"],
  ]) {
    assert.equal(manager.searchNotes(query, 10)[0]?.title, expectedTitle, query);
  }
});

test("DatabaseManager.searchNotes returns no rows for empty normalized queries", (t) => {
  const { manager, sqlite } = createSearchDatabase();
  t.after(() => sqlite.close());

  assert.deepEqual(manager.searchNotes("!!!", 10), []);
  assert.deepEqual(manager.searchNotes("   ", 10), []);
});

test("DatabaseManager.searchNotes treats FTS5 operators and punctuation as text", (t) => {
  const { manager, sqlite } = createSearchDatabase();
  t.after(() => sqlite.close());

  assert.ok(manager.searchNotes("OR", 10).some((note) => note.title === "OR operation"));
  assert.equal(manager.searchNotes("hello -world", 10)[0]?.title, "hello world");
  assert.deepEqual(manager.searchNotes("title:", 10), []);
  assert.deepEqual(manager.searchNotes('foo"bar', 10), []);
});
