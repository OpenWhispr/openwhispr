const test = require("node:test");
const assert = require("node:assert/strict");

const { canonicalizeHotkey } = require("../../src/helpers/hotkeyCanonical.js");

const load = () => import("../../src/helpers/dictationHotkeyConfig.js");
const canon = (key) => canonicalizeHotkey(key, "win32");

test("rows keep the spelling the user typed", async () => {
  const { parseConfig, serializeConfig } = await load();

  const rows = parseConfig(
    JSON.stringify([
      { key: "Ctrl+Shift+Space", mode: "cleaned" },
      { key: "Control+Alt+Shift", mode: "raw" },
    ]),
    canon
  );

  assert.deepEqual(rows, [
    { key: "Ctrl+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ]);
  // Round-trips verbatim: canonicalization is for comparison, never storage.
  assert.deepEqual(parseConfig(serializeConfig(rows), canon), rows);
});

test("an unrecognized mode becomes null instead of reaching the pipeline", async () => {
  const { parseConfig, normalizeMode } = await load();

  const rows = parseConfig(
    JSON.stringify([
      { key: "F8", mode: "on" },
      { key: "F9", mode: "always-off" },
      { key: "F10", mode: undefined },
      { key: "F11", mode: "raw" },
    ]),
    canon
  );

  assert.deepEqual(
    rows.map((r) => r.mode),
    [null, null, null, "raw"]
  );
  // resolveCleanupSelection treats anything that is not raw/cleaned as the
  // global preference, so an unknown value must never get that far.
  assert.equal(normalizeMode("on"), null);
  assert.equal(normalizeMode("cleaned"), "cleaned");
});

test("malformed or absent config parses to no rows rather than throwing", async () => {
  const { parseConfig } = await load();

  for (const raw of ["", "   ", "not json", "{", "null", undefined, null, 7]) {
    assert.deepEqual(parseConfig(raw, canon), [], JSON.stringify(raw));
  }
  // A truncated array still yields whatever rows survived parsing.
  assert.deepEqual(parseConfig('[{"key":"F8","mode":"raw"}]', canon), [{ key: "F8", mode: "raw" }]);
});

test("two spellings of one chord collapse to a single row", async () => {
  const { pruneRows } = await load();

  const rows = pruneRows(
    [
      { key: "Ctrl+Shift+Space", mode: "cleaned" },
      { key: "Control+Shift+Space", mode: "raw" },
      { key: "Shift+Control+Space", mode: "raw" },
      { key: "Control+Alt+Shift", mode: "raw" },
    ],
    canon
  );

  assert.deepEqual(rows, [
    { key: "Ctrl+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ]);
});

test("blank and malformed rows are dropped", async () => {
  const { pruneRows } = await load();

  assert.deepEqual(
    pruneRows([null, undefined, "", { key: "  " }, { mode: "raw" }, { key: " F8 " }], canon),
    [{ key: "F8", mode: null }]
  );
});

test("a legacy flat list loads as Use app setting, never pinned", async () => {
  const { rowsFromHotkeyList } = await load();

  assert.deepEqual(rowsFromHotkeyList(["Control+Super", "F8"], canon), [
    { key: "Control+Super", mode: null },
    { key: "F8", mode: null },
  ]);
  assert.deepEqual(rowsFromHotkeyList([], canon), []);
  assert.deepEqual(rowsFromHotkeyList(undefined, canon), []);
});

test("the mode is found through any spelling of the same chord", async () => {
  const { modeFor } = await load();
  const rows = [
    { key: "Ctrl+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ];

  for (const spelling of ["Ctrl+Shift+Space", "Control+Shift+Space", "Shift+Control+Space"]) {
    assert.equal(modeFor(rows, spelling, canon), "cleaned", spelling);
  }
  assert.equal(modeFor(rows, "Control+Alt+Shift", canon), "raw");
  // An unknown key follows the app setting — the conservative answer.
  assert.equal(modeFor(rows, "F12", canon), null);
  assert.equal(modeFor(rows, "", canon), null);
});

// The row object is the identity, so an override cannot migrate to a
// neighbour — the failure the brief calls out by name.
test("renaming a row carries its own mode and leaves the others alone", async () => {
  const { renameRow } = await load();
  const rows = [
    { key: "Control+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ];

  assert.deepEqual(renameRow(rows, 0, "Control+Shift+K"), [
    { key: "Control+Shift+K", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ]);
  // Out of range or empty leaves the list untouched.
  assert.equal(renameRow(rows, 5, "F8"), rows);
  assert.equal(renameRow(rows, 0, "   "), rows);
});

test("removing a row takes its override with it", async () => {
  const { removeRow, modeFor } = await load();
  const rows = [
    { key: "Control+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ];

  const after = removeRow(rows, 0);
  assert.deepEqual(after, [{ key: "Control+Alt+Shift", mode: "raw" }]);
  // The survivor keeps its own mode rather than inheriting the removed one.
  assert.equal(modeFor(after, "Control+Alt+Shift", canon), "raw");
  // Re-adding the same key starts clean, with no resurrected override.
  const readded = [...after, { key: "Control+Shift+Space", mode: null }];
  assert.equal(modeFor(readded, "Control+Shift+Space", canon), null);
});

test("setting a mode changes only that row", async () => {
  const { setRowMode } = await load();
  const rows = [
    { key: "F8", mode: null },
    { key: "F9", mode: "raw" },
  ];

  assert.deepEqual(setRowMode(rows, 0, "cleaned"), [
    { key: "F8", mode: "cleaned" },
    { key: "F9", mode: "raw" },
  ]);
  assert.deepEqual(setRowMode(rows, 1, "nonsense"), [
    { key: "F8", mode: null },
    { key: "F9", mode: null },
  ]);
});

// A selector-only edit must not re-register an OS shortcut: that is churn on a
// path that can fail, and it would let a rollback restore an old key bound to
// the failed edit's mode.
test("a mode-only change is recognised as needing no re-registration", async () => {
  const { isModeOnlyChange } = await load();
  const before = [
    { key: "Ctrl+Shift+Space", mode: null },
    { key: "Control+Alt+Shift", mode: "raw" },
  ];

  assert.equal(
    isModeOnlyChange(
      before,
      [
        { key: "Ctrl+Shift+Space", mode: "cleaned" },
        { key: "Control+Alt+Shift", mode: "raw" },
      ],
      canon
    ),
    true
  );
  // A different spelling of the same chord is still mode-only.
  assert.equal(
    isModeOnlyChange(
      before,
      [
        { key: "Control+Shift+Space", mode: "cleaned" },
        { key: "Control+Alt+Shift", mode: "raw" },
      ],
      canon
    ),
    true
  );
  // A real key change is not.
  assert.equal(
    isModeOnlyChange(
      before,
      [
        { key: "Control+Shift+K", mode: null },
        { key: "Control+Alt+Shift", mode: "raw" },
      ],
      canon
    ),
    false
  );
  // Neither is adding or removing a row.
  assert.equal(isModeOnlyChange(before, [before[0]], canon), false);
});

test("the derived flat list keeps original spellings and row order", async () => {
  const { rowKeys } = await load();

  assert.deepEqual(
    rowKeys([
      { key: "Ctrl+Shift+Space", mode: "cleaned" },
      { key: "Control+Alt+Shift", mode: "raw" },
    ]),
    ["Ctrl+Shift+Space", "Control+Alt+Shift"]
  );
});
