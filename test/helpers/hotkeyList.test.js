const test = require("node:test");
const assert = require("node:assert/strict");

const { parseHotkeyList, serializeHotkeyList } = require("../../src/helpers/hotkeyList.js");

test("parses a legacy single hotkey into a one-element list", () => {
  assert.deepEqual(parseHotkeyList("Control+Shift+R"), ["Control+Shift+R"]);
  assert.deepEqual(parseHotkeyList("GLOBE"), ["GLOBE"]);
});

test("parses a comma-separated list", () => {
  assert.deepEqual(parseHotkeyList("GLOBE,Control+Shift+R"), ["GLOBE", "Control+Shift+R"]);
});

test("trims whitespace around each hotkey", () => {
  assert.deepEqual(parseHotkeyList(" GLOBE , Control+Shift+R "), ["GLOBE", "Control+Shift+R"]);
});

test("drops empty entries and de-duplicates, preserving order", () => {
  assert.deepEqual(parseHotkeyList("F8,,F8,F9,"), ["F8", "F9"]);
});

test("handles empty / nullish input", () => {
  assert.deepEqual(parseHotkeyList(""), []);
  assert.deepEqual(parseHotkeyList(null), []);
  assert.deepEqual(parseHotkeyList(undefined), []);
});

test("accepts an array and normalizes it (including nested comma strings)", () => {
  assert.deepEqual(parseHotkeyList(["GLOBE", "Control+Shift+R"]), ["GLOBE", "Control+Shift+R"]);
  assert.deepEqual(parseHotkeyList(["GLOBE,Control+Alt", " F8 "]), ["GLOBE", "Control+Alt", "F8"]);
});

test("serializes a list back to a canonical comma-separated string", () => {
  assert.equal(serializeHotkeyList(["GLOBE", "Control+Shift+R"]), "GLOBE,Control+Shift+R");
  assert.equal(serializeHotkeyList("F8, F9 ,F8"), "F8,F9");
  assert.equal(serializeHotkeyList([]), "");
  assert.equal(serializeHotkeyList(null), "");
});

test("round-trips parse -> serialize -> parse", () => {
  const input = " GLOBE , Control+Shift+R , MouseButton4 ";
  const once = serializeHotkeyList(input);
  assert.equal(once, "GLOBE,Control+Shift+R,MouseButton4");
  assert.deepEqual(parseHotkeyList(once), ["GLOBE", "Control+Shift+R", "MouseButton4"]);
});

test("keeps a legacy comma-key hotkey intact (the comma is the key, not a separator)", () => {
  assert.deepEqual(parseHotkeyList("Control+,"), ["Control+,"]);
  assert.deepEqual(parseHotkeyList("Command+Shift+,"), ["Command+Shift+,"]);
});

test("parses comma-key hotkeys inside a list", () => {
  assert.deepEqual(parseHotkeyList("GLOBE,Control+,"), ["GLOBE", "Control+,"]);
  assert.deepEqual(parseHotkeyList("Control+,,F8"), ["Control+,", "F8"]);
  assert.deepEqual(parseHotkeyList(["Control+,", "F8"]), ["Control+,", "F8"]);
});

test("round-trips lists containing comma-key hotkeys", () => {
  const list = ["Control+,", "F8", "GLOBE"];
  const serialized = serializeHotkeyList(list);
  assert.equal(serialized, "Control+,,F8,GLOBE");
  assert.deepEqual(parseHotkeyList(serialized), list);
});
