const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../scripts/local-model-exam/lib/score.mjs");

test("English numbers score the same however they are written", async () => {
  const s = await load();
  const ref = "Please email Priya the budget by Thursday at three thirty.";
  for (const hyp of [
    "Please email Priya the budget by Thursday at 3.30.",
    "please email priya the budget by thursday at 330",
    "Please email Priya the budget by Thursday at three-thirty",
  ]) {
    assert.equal(s.errorsPer100(s.errorCounts(ref, hyp, "en-US")), 0, hyp);
  }
  assert.deepEqual(s.canonicalEnglishNumbers("twenty five".split(" ")), ["25"]);
  assert.deepEqual(s.canonicalEnglishNumbers("two thousand and twenty six".split(" ")), ["2026"]);
  assert.deepEqual(s.canonicalEnglishNumbers("one hundred twenty people".split(" ")), [
    "120",
    "people",
  ]);
  assert.deepEqual(s.canonicalEnglishNumbers("fifty percent".split(" ")), ["50"]);
});

test("word errors count substitutions, deletions and insertions", async () => {
  const s = await load();
  const c = s.errorCounts("the cat sat on the mat", "the cat sat on mat", "en");
  assert.equal(c.deletions, 1);
  assert.equal(c.referenceUnits, 6);
  assert.equal(s.errorsPer100(s.errorCounts("Hello, World!", "hello world", "en")), 0);
});

test("languages written without spaces are scored by characters", async () => {
  const s = await load();
  const ja = s.errorCounts("今日は晴れです", "今日は雨です", "ja");
  assert.equal(ja.unit, "char");
  assert.equal(ja.referenceUnits, 7);
  assert.ok(s.errorsPer100(ja) < 50);
});

test("silence output counts every word", async () => {
  const s = await load();
  assert.equal(s.addedWords(""), 0);
  assert.equal(s.addedWords("  ...  "), 0);
  assert.equal(s.addedWords("Продолжение следует..."), 2);
  assert.equal(s.addedWords("Thank you."), 2);
});

test("only words in the silent stretch count as made up", async () => {
  const s = await load();
  // A long word heard as two inside the speech is a recognition error.
  const de =
    "Löwenrudel agieren ähnlich wie Wolfs- oder Hunderudel, Tiere, die den Löwen aber nicht anderen Großkatzen im Verhalten überraschend ähneln und ebenso tödlich gegenüber ihrer Beute sind.";
  const deHyp =
    "Löwenrudel agieren ähnlich wie Wolfs oder Hunderrudel. Tiere, die den Löwen, aber nicht anderen großer. Gratzen im Verhalten überraschend innen und ebenso tödlich gegenüber Ihrer Beute sind.";
  assert.equal(s.insertionsOutsideSpeech([de], deHyp, "de"), 0);
  assert.equal(s.insertionsOutsideSpeech(["hello world"], "hello world thank you", "en"), 2);
  assert.equal(s.insertionsOutsideSpeech(["hello world"], "hello wor ld", "en"), 0);
  assert.equal(
    s.insertionsOutsideSpeech(["one two", "three four"], "one two thanks three four", "en"),
    1
  );
  assert.equal(s.insertionsOutsideSpeech(["one two", "three four"], "one too three four", "en"), 0);
});
