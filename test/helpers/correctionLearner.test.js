const test = require("node:test");
const assert = require("node:assert/strict");

const { extractCorrections } = require("../../src/utils/correctionLearner.js");

test("null or empty inputs yield no corrections", () => {
  assert.deepEqual(extractCorrections(null, "hello", []), []);
  assert.deepEqual(extractCorrections("hello", null, []), []);
  assert.deepEqual(extractCorrections("", "hello", []), []);
  assert.deepEqual(extractCorrections("hello", "", []), []);
});

test("identical texts yield no corrections", () => {
  assert.deepEqual(extractCorrections("hello world", "hello world", []), []);
});

test("a phonetic mishearing fixed by the user is learned", () => {
  // "Shunade" is a plausible transcription mishearing of "Sinead"
  const result = extractCorrections("Hey Shunade how are you", "Hey Sinead how are you", []);
  assert.ok(result.includes("Sinead"));
});

test("corrections already in the dictionary are not re-learned, case-insensitively", () => {
  const original = "Hey Shunade how are you";
  const edited = "Hey Sinead how are you";

  assert.ok(!extractCorrections(original, edited, ["Sinead"]).includes("Sinead"));
  assert.ok(!extractCorrections(original, edited, ["sinead"]).includes("Sinead"));
});

test("a wholesale rewrite is not mistaken for corrections", () => {
  const result = extractCorrections("the cat sat on the mat", "a dog stood under a rug", []);
  assert.deepEqual(result, []);
});

test("very short replacements are ignored — two-letter words are edits, not vocabulary", () => {
  const result = extractCorrections("I went to see XX today", "I went to see Al today", []);
  assert.ok(!result.includes("Al"));
});

test("unrelated word swaps are filtered by edit distance — cat to elephant is a rewrite, not a mishearing", () => {
  const result = extractCorrections("I saw a cat yesterday", "I saw a elephant yesterday", []);
  assert.ok(!result.includes("elephant"));
});

test("a non-array dictionary is tolerated", () => {
  const result = extractCorrections("Hey Shunade", "Hey Sinead", null);
  assert.ok(result.includes("Sinead"));
});

test("the same correction appearing twice is only learned once", () => {
  const result = extractCorrections("Shunade said hi to Shunade", "Sinead said hi to Sinead", []);
  const sinead = result.filter((w) => w.toLowerCase() === "sinead");
  assert.ok(sinead.length <= 1);
});
