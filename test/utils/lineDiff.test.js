const test = require("node:test");
const assert = require("node:assert/strict");

let lineDiff;
let foldUnchanged;

test.before(async () => {
  ({ lineDiff, foldUnchanged } = await import("../../src/utils/lineDiff.ts"));
});

const lines = (diff) => diff.map(({ kind, text }) => `${kind}${text}`);

test("unchanged, added and removed lines come out in order", () => {
  assert.deepEqual(lines(lineDiff("a\nb\nc", "a\nc\nd")), [" a", "-b", " c", "+d"]);
  assert.deepEqual(lines(lineDiff("Keep\nold rule\nEnd\n", "Keep\nnew rule\nEnd\n")), [
    " Keep",
    "-old rule",
    "+new rule",
    " End",
  ]);
  assert.deepEqual(lines(lineDiff("", "First\r\nSecond")), ["+First", "+Second"]);
});

test("identical texts give only unchanged lines", () => {
  assert.deepEqual(lineDiff("x\ny\n", "x\ny\n"), [
    { kind: " ", text: "x" },
    { kind: " ", text: "y" },
  ]);
});

test("one change in a long file is shown as that change alone", () => {
  const before = Array.from({ length: 5_000 }, (_, index) => `line ${index}`);
  const after = [...before.slice(0, 2_500), "changed", ...before.slice(2_501)];

  const diff = lineDiff(before.join("\n"), after.join("\n"));

  assert.equal(diff.length, 5_001);
  assert.deepEqual(
    diff.filter((line) => line.kind !== " "),
    [
      { kind: "-", text: "line 2500" },
      { kind: "+", text: "changed" },
    ]
  );
});

test("a changed run over 2,000 lines falls back to whole removed and added blocks", () => {
  const before = Array.from({ length: 2_001 }, (_, index) => `old ${index}`);
  const after = Array.from({ length: 2_001 }, (_, index) => `new ${index}`);

  const diff = lineDiff(["Keep", ...before].join("\n"), ["Keep", ...after].join("\n"));

  assert.equal(diff.length, 4_003);
  assert.deepEqual(diff[0], { kind: " ", text: "Keep" });
  assert.deepEqual(
    diff.slice(1, 2_002),
    before.map((text) => ({ kind: "-", text }))
  );
  assert.deepEqual(
    diff.slice(2_002),
    after.map((text) => ({ kind: "+", text }))
  );
});

test("long unchanged runs fold to a count, keeping two lines beside each change", () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`);
  const after = [...before.slice(0, 10), "changed", ...before.slice(11)];

  const folded = foldUnchanged(lineDiff(before.join("\n"), after.join("\n")));

  assert.deepEqual(
    folded.map((line) => (line.kind === "fold" ? `…${line.count}` : `${line.kind}${line.text}`)),
    ["…8", " line 8", " line 9", "-line 10", "+changed", " line 11", " line 12", "…7"]
  );
  const folds = (before, after) =>
    foldUnchanged(lineDiff(before, after)).some((line) => line.kind === "fold");
  // A run only a line longer than its context is shown whole.
  assert.equal(folds("a\nb\nc\nd", "a\nb\nc\nX"), false);
  assert.equal(folds("a\nb\nc\nd\ne", "a\nb\nc\nd\nX"), true);
});
