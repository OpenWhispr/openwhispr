const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/markdownTable.ts");

test("escapeTableCellPipes escapes every pipe, including one after a backslash or in code", async () => {
  const { escapeTableCellPipes } = await load();
  assert.equal(escapeTableCellPipes("a|b"), "a\\|b");
  assert.equal(escapeTableCellPipes("`x|y`"), "`x\\|y`");
  // A serialized literal backslash is already doubled; the pipe still needs its own escape.
  assert.equal(escapeTableCellPipes("a\\\\|b"), "a\\\\\\|b");
  assert.equal(escapeTableCellPipes("no pipes"), "no pipes");
});

test("parseTableHeaderRow reads the labels of a typed header row", async () => {
  const { parseTableHeaderRow } = await load();
  assert.deepEqual(parseTableHeaderRow("| Item | Cost |"), ["Item", "Cost"]);
  assert.deepEqual(parseTableHeaderRow("  |Item|Cost|  "), ["Item", "Cost"]);
  assert.deepEqual(parseTableHeaderRow("| Single |"), ["Single"]);
  assert.deepEqual(parseTableHeaderRow("| Name | |"), ["Name", ""]);
  assert.deepEqual(parseTableHeaderRow("| a \\| b | c |"), ["a | b", "c"]);
});

test("parseTableHeaderRow rejects lines that are not a header row", async () => {
  const { parseTableHeaderRow } = await load();
  for (const line of [
    "",
    "|",
    "||",
    "| |",
    "plain text",
    "a | b",
    "| a | b",
    "| a \\|",
    "| --- | :-: |",
    "| a |\n| b |",
  ]) {
    assert.equal(parseTableHeaderRow(line), null, line);
  }
});
