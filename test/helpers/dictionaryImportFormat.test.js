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
