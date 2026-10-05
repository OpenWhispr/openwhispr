const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildEmojiRows,
  emojiAt,
  firstEmojiPosition,
  groupEmoji,
  isRegionalFlag,
  logicalArrowKey,
  moveEmojiPosition,
  pushRecentEmoji,
  searchEmoji,
  visibleEmoji,
} = require("../../src/lib/emojiPicker.ts");

const entry = (emoji, label, group = 0, version = 1, tags) => ({
  emoji,
  label,
  group,
  version,
  ...(tags ? { tags } : {}),
});

const GRIN = entry("😀", "grinning face", 0, 1, ["happy", "smile"]);
const ROCKET = entry("🚀", "Rocket", 5, 1, ["space"]);
const DOG = entry("🐶", "dog face", 3, 1);
const FLAG = entry("🇩🇪", "flag: Germany", 9, 2);
const RAINBOW = entry("🏳️‍🌈", "rainbow flag", 9, 4);
const NEW = entry("🫩", "face with bags under eyes", 0, 16);
const GROUPS = { 0: "smileys", 1: "people", 3: "animals", 4: "food", 5: "travel" };

test("searchEmoji matches labels and tags case-insensitively and ignores padding", () => {
  const entries = [GRIN, ROCKET, DOG];
  assert.deepEqual(searchEmoji(entries, "  ROCK "), [ROCKET]);
  assert.deepEqual(searchEmoji(entries, "smile"), [GRIN]);
  assert.deepEqual(searchEmoji(entries, "zzz"), []);
  assert.equal(searchEmoji(entries, "   "), entries);
});

test("visibleEmoji drops newer versions than the platform renders and regional flags on demand", () => {
  const entries = [GRIN, FLAG, RAINBOW, NEW];
  assert.deepEqual(visibleEmoji(entries, { maxVersion: 15.1, hideRegionalFlags: false }), [
    GRIN,
    FLAG,
    RAINBOW,
  ]);
  assert.deepEqual(visibleEmoji(entries, { maxVersion: Infinity, hideRegionalFlags: true }), [
    GRIN,
    RAINBOW,
    NEW,
  ]);
});

test("isRegionalFlag spots country and subdivision flags but not other flags", () => {
  assert.equal(isRegionalFlag("🇩🇪"), true);
  assert.equal(isRegionalFlag("🏴󠁧󠁢󠁥󠁮󠁧󠁿"), true);
  assert.equal(isRegionalFlag("🏁"), false);
  assert.equal(isRegionalFlag("🏳️‍🌈"), false);
  assert.equal(isRegionalFlag("😀"), false);
});

test("groupEmoji orders sections by group id and keeps entry order within a group", () => {
  const second = entry("😃", "grinning face with big eyes");
  assert.deepEqual(groupEmoji([ROCKET, GRIN, DOG, second], GROUPS), [
    { title: "smileys", items: [GRIN, second] },
    { title: "animals", items: [DOG] },
    { title: "travel", items: [ROCKET] },
  ]);
});

test("buildEmojiRows chunks by column count, labels titled sections, skips empty ones", () => {
  const items = [GRIN, ROCKET, DOG];
  const rows = buildEmojiRows(
    [
      { title: "Recent", items: [] },
      { title: "smileys", items },
      { title: null, items: [FLAG] },
    ],
    2
  );
  assert.deepEqual(rows, [
    { kind: "header", title: "smileys" },
    { kind: "emoji", items: [GRIN, ROCKET] },
    { kind: "emoji", items: [DOG] },
    { kind: "emoji", items: [FLAG] },
  ]);
});

test("keyboard movement wraps across rows, skips headers and clamps to shorter rows", () => {
  const rows = buildEmojiRows(
    [
      { title: "a", items: [GRIN, ROCKET, DOG] },
      { title: "b", items: [FLAG, NEW] },
    ],
    3
  );
  // rows: 0 header, 1 [GRIN ROCKET DOG], 2 header, 3 [FLAG NEW]
  assert.deepEqual(firstEmojiPosition(rows), { row: 1, col: 0 });
  assert.deepEqual(moveEmojiPosition(rows, { row: 1, col: 2 }, "ArrowRight"), { row: 3, col: 0 });
  assert.deepEqual(moveEmojiPosition(rows, { row: 3, col: 0 }, "ArrowLeft"), { row: 1, col: 2 });
  assert.deepEqual(moveEmojiPosition(rows, { row: 1, col: 2 }, "ArrowDown"), { row: 3, col: 1 });
  assert.deepEqual(moveEmojiPosition(rows, { row: 3, col: 1 }, "ArrowUp"), { row: 1, col: 1 });
  assert.deepEqual(moveEmojiPosition(rows, { row: 1, col: 0 }, "ArrowLeft"), { row: 1, col: 0 });
  assert.deepEqual(moveEmojiPosition(rows, { row: 3, col: 1 }, "ArrowDown"), { row: 3, col: 1 });
  assert.equal(emojiAt(rows, { row: 3, col: 1 }), NEW);
  assert.equal(emojiAt(rows, { row: 0, col: 0 }), null);
  assert.equal(firstEmojiPosition([]), null);
});

test("logicalArrowKey mirrors horizontal keys in RTL only", () => {
  assert.equal(logicalArrowKey("ArrowLeft", "rtl"), "ArrowRight");
  assert.equal(logicalArrowKey("ArrowRight", "rtl"), "ArrowLeft");
  assert.equal(logicalArrowKey("ArrowDown", "rtl"), "ArrowDown");
  assert.equal(logicalArrowKey("ArrowLeft", "ltr"), "ArrowLeft");
});

test("pushRecentEmoji moves repeats to the front and caps the list", () => {
  assert.deepEqual(pushRecentEmoji(["🚀", "😀"], "😀"), ["😀", "🚀"]);
  assert.deepEqual(pushRecentEmoji(["a", "b", "c"], "d", 3), ["d", "a", "b"]);
});
