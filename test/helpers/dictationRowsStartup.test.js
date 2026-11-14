const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Dispatch resolves a recording's cleanup from main's row cache, so a launch
// that never fills it would run every shortcut on the app setting until the
// user next touched Settings. This is main.js's own restore function, sliced
// out and run against a stored profile.

const { parseConfig, rowsFromHotkeyList } = require("../../src/helpers/dictationHotkeyConfig.js");
const { canonicalizeHotkey } = require("../../src/helpers/hotkeyCanonical.js");
const { parseHotkeyList } = require("../../src/helpers/hotkeyList.js");

const main = fs.readFileSync(path.join(__dirname, "../../main.js"), "utf8");
const start = main.indexOf("function restoreDictationRows() {");
assert.notEqual(start, -1, "restoreDictationRows not found in main.js");
const source = main.slice(start, main.indexOf("\n}\n", start) + 3);

const encode = (json) => Buffer.from(json, "utf8").toString("base64");

function restore(environmentManager) {
  const warnings = [];
  const context = {
    environmentManager,
    parseDictationRowConfig: parseConfig,
    dictationRowsFromHotkeyList: rowsFromHotkeyList,
    canonicalizeHotkey,
    parseHotkeyList,
    debugLogger: { warn: (...args) => warnings.push(args) },
  };
  const rows = vm.runInNewContext(`${source}\nrestoreDictationRows();`, context);
  return { rows: JSON.parse(JSON.stringify(rows)), warnings };
}

// The stored value is base64 because dotenv truncates an unquoted value at "#"
// and dotenv 17 does not unescape \" inside a quoted one — a hotkey as
// ordinary as Control+# would otherwise take every later row with it.
test("a stored configuration restores every row with its own mode", () => {
  const { rows } = restore({
    getDictationHotkeyConfig: () =>
      JSON.stringify([
        { key: "Ctrl+Shift+Space", mode: "cleaned" },
        { key: "Control+Alt+Shift", mode: "raw" },
      ]),
    getDictationKey: () => "Ctrl+Shift+Space,Control+Alt+Shift",
  });

  assert.deepEqual(rows, [
    { key: "Ctrl+Shift+Space", mode: "cleaned" },
    { key: "Control+Alt+Shift", mode: "raw" },
  ]);
});

test("the spelling the user typed survives the round trip", () => {
  const { rows } = restore({
    getDictationHotkeyConfig: () =>
      JSON.stringify([{ key: "CommandOrControl+Shift+K", mode: "raw" }]),
    getDictationKey: () => "CommandOrControl+Shift+K",
  });

  assert.deepEqual(rows, [{ key: "CommandOrControl+Shift+K", mode: "raw" }]);
});

test("a profile with no configuration loads its keys on the app setting", () => {
  const { rows } = restore({
    getDictationHotkeyConfig: () => "",
    getDictationKey: () => "Control+Super,F8",
  });

  // Never reinterpreted from today's global preference: an unknown mode is
  // "follow the app setting", which is what these rows did before the feature.
  assert.deepEqual(rows, [
    { key: "Control+Super", mode: null },
    { key: "F8", mode: null },
  ]);
});

test("a hand-written configuration is read as JSON, not only as base64", () => {
  const { rows } = restore({
    // getDictationHotkeyConfig accepts a hand-edited `[...]` as written.
    getDictationHotkeyConfig: () => '[{"key":"F9","mode":"cleaned"}]',
    getDictationKey: () => "F9",
  });

  assert.deepEqual(rows, [{ key: "F9", mode: "cleaned" }]);
});

test("a malformed configuration falls back to the keys rather than failing launch", () => {
  const { rows, warnings } = restore({
    getDictationHotkeyConfig: () => "not json at all",
    getDictationKey: () => "F8",
  });

  assert.deepEqual(rows, [{ key: "F8", mode: null }]);
  assert.deepEqual(warnings, []);
});

test("a storage layer that throws leaves every row on the app setting", () => {
  const { rows, warnings } = restore({
    getDictationHotkeyConfig: () => {
      throw new Error("secure storage unavailable");
    },
    getDictationKey: () => "F8",
  });

  assert.deepEqual(rows, [], "no rows rather than a thrown launch");
  assert.equal(warnings.length, 1);
});

// Pins the encoding the commit writes against the reader above.
test("the base64 form the commit writes reads back identically", () => {
  const config = JSON.stringify([{ key: "Control+#", mode: "raw" }]);
  const { rows } = restore({
    getDictationHotkeyConfig: () => Buffer.from(encode(config), "base64").toString("utf8"),
    getDictationKey: () => "Control+#",
  });

  assert.deepEqual(rows, [{ key: "Control+#", mode: "raw" }]);
});
