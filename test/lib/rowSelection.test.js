const test = require("node:test");
const assert = require("node:assert/strict");
const { toggleRow, setRows, keepRows, headerCheckState } = require("../../src/lib/rowSelection.ts");

test("toggling adds and removes", () => {
  const empty = new Set();

  const one = toggleRow(empty, "a");
  assert.deepEqual([...one], ["a"]);
  assert.deepEqual([...empty], [], "the original set is left alone");

  const none = toggleRow(one, "a");
  assert.deepEqual([...none], []);
  assert.deepEqual([...one], ["a"]);
});

test("select all affects only the given ids", () => {
  const selection = new Set(["hidden"]);

  const all = setRows(selection, ["a", "b"], true);
  assert.deepEqual([...all].sort(), ["a", "b", "hidden"]);

  const cleared = setRows(all, ["a", "b"], false);
  assert.deepEqual([...cleared], ["hidden"]);
  assert.deepEqual([...all].sort(), ["a", "b", "hidden"]);
});

test("keepRows returns the same set when nothing is dropped", () => {
  const selection = new Set(["a", "b"]);

  assert.equal(keepRows(selection, ["a", "b", "c"]), selection);
  assert.equal(keepRows(selection, new Set(["b", "a"])), selection);

  const kept = keepRows(selection, ["b", "c"]);
  assert.notEqual(kept, selection);
  assert.deepEqual([...kept], ["b"]);
});

test("header state is some when part of the visible rows is selected", () => {
  assert.equal(headerCheckState(["a", "b"], new Set(["a"])), "some");
  assert.equal(headerCheckState(["a", "b"], new Set(["a", "b", "off-screen"])), "all");
  assert.equal(headerCheckState(["a", "b"], new Set(["off-screen"])), "none");
  // Nothing to select is never "all", so the header box isn't drawn checked over an empty table.
  assert.equal(headerCheckState([], new Set(["a"])), "none");
});
