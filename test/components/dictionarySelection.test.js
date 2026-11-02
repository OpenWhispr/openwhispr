const test = require("node:test");
const assert = require("node:assert/strict");
const { selectionReducer } = require("../../src/components/dictionary/useDictionarySelection.ts");

const EMPTY = { selected: new Set(), anchor: null };
const KEYS = ["a", "b", "c", "d", "e"];
const keysOf = (state) => [...state.selected].sort();

test("toggle adds and removes a key and moves the anchor", () => {
  const once = selectionReducer(EMPTY, { type: "toggle", key: "b" });
  assert.deepEqual(keysOf(once), ["b"]);
  assert.equal(once.anchor, "b");

  const twice = selectionReducer(once, { type: "toggle", key: "d" });
  assert.deepEqual(keysOf(twice), ["b", "d"]);
  assert.equal(twice.anchor, "d");

  const removed = selectionReducer(twice, { type: "toggle", key: "b" });
  assert.deepEqual(keysOf(removed), ["d"]);
  assert.equal(removed.anchor, "b");
});

test("range from anchor selects every key between, in either direction", () => {
  const anchored = selectionReducer(EMPTY, { type: "toggle", key: "b" });
  const down = selectionReducer(anchored, { type: "range", key: "d", orderedKeys: KEYS });
  assert.deepEqual(keysOf(down), ["b", "c", "d"]);
  assert.equal(down.anchor, "b", "the anchor stays put, so the range can be redrawn");

  const fromE = selectionReducer(EMPTY, { type: "toggle", key: "e" });
  const up = selectionReducer(fromE, { type: "range", key: "c", orderedKeys: KEYS });
  assert.deepEqual(keysOf(up), ["c", "d", "e"]);

  // Keys selected outside the range stay selected.
  const withA = selectionReducer(down, { type: "toggle", key: "a" });
  const extended = selectionReducer(withA, { type: "range", key: "e", orderedKeys: KEYS });
  assert.deepEqual(keysOf(extended), KEYS);
});

test("range without a usable anchor selects just the clicked key", () => {
  const noAnchor = selectionReducer(EMPTY, { type: "range", key: "c", orderedKeys: KEYS });
  assert.deepEqual(keysOf(noAnchor), ["c"]);
  assert.equal(noAnchor.anchor, "c");

  // An anchor that left the list (filtered out, deleted) counts as none.
  const stale = { selected: new Set(["z"]), anchor: "z" };
  const fromStale = selectionReducer(stale, { type: "range", key: "b", orderedKeys: KEYS });
  assert.deepEqual(keysOf(fromStale), ["b", "z"]);
  assert.equal(fromStale.anchor, "b");
});

test("selectAll selects every listed key", () => {
  const anchored = selectionReducer(EMPTY, { type: "toggle", key: "b" });
  const all = selectionReducer(anchored, { type: "selectAll", orderedKeys: KEYS });
  assert.deepEqual(keysOf(all), KEYS);
});

test("clear empties the selection and drops the anchor", () => {
  const some = selectionReducer(EMPTY, { type: "selectAll", orderedKeys: KEYS });
  const cleared = selectionReducer(some, { type: "clear" });
  assert.equal(cleared.selected.size, 0);
  assert.equal(cleared.anchor, null);
  // Clearing nothing keeps the same state, so React skips the render.
  assert.equal(selectionReducer(cleared, { type: "clear" }), cleared);
});

test("retain drops keys and an anchor that left the list", () => {
  const some = selectionReducer(EMPTY, { type: "selectAll", orderedKeys: KEYS });
  const anchored = selectionReducer(some, { type: "toggle", key: "e" });
  const pruned = selectionReducer(anchored, { type: "retain", orderedKeys: ["a", "b", "c"] });
  assert.deepEqual(keysOf(pruned), ["a", "b", "c"]);
  assert.equal(pruned.anchor, null);
  // Nothing to drop keeps the same state, so rows changing never loops.
  assert.equal(selectionReducer(pruned, { type: "retain", orderedKeys: KEYS }), pruned);
});

test("selectAll adds the listed keys to what is already selected", () => {
  // A search shows c, d and e; a and b, ticked before it, stay ticked.
  const some = selectionReducer(EMPTY, { type: "selectAll", orderedKeys: ["a", "b"] });
  const all = selectionReducer(some, { type: "selectAll", orderedKeys: ["c", "d", "e"] });
  assert.deepEqual(keysOf(all), KEYS);
});
