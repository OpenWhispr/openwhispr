const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/dictionaryImport.js");

test("import accepts comma-separated words", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice, Bob, Carol"), ["Alice", "Bob", "Carol"]);
});

test("import accepts one word per line", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice\nBob\nCarol"), ["Alice", "Bob", "Carol"]);
});

test("import accepts mixed commas and new lines and skips blanks", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice,\n Bob\n\nCarol, "), [
    "Alice",
    "Bob",
    "Carol",
  ]);
});

test("import accepts carriage return and CRLF line endings", async () => {
  const { parseDictionaryImportText } = await load();
  assert.deepEqual(parseDictionaryImportText("Alice\rBob\rCarol"), ["Alice", "Bob", "Carol"]);
  assert.deepEqual(parseDictionaryImportText("Alice\r\nBob\r\nCarol"), ["Alice", "Bob", "Carol"]);
  assert.deepEqual(parseDictionaryImportText("Alice,\r\n Bob\r\n\r\nCarol,\rDave"), [
    "Alice",
    "Bob",
    "Carol",
    "Dave",
  ]);
});
