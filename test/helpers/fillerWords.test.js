const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/fillerWords.js");

test("strips fillers with their surrounding punctuation mid-sentence", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("But, uh, does it, um... work"), "But does it work");
});

test("capitalises the next word when the leading filler is removed", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("Um, hello."), "Hello.");
});

test("matches fillers regardless of case", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("UH, Ok Um yes"), "Ok yes");
});

test("never removes a filler that is part of another word", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("summer humm ahead"), "summer humm ahead");
});

test("honours a custom word list", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("like, basically it works", ["like", "basically"]), "It works");
  // Words outside the custom list survive.
  assert.equal(removeFillerWords("um like it", ["like"]), "um it");
});

test("returns the input unchanged when the list is empty", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("um, hello"), "Hello");
  assert.equal(removeFillerWords("um, hello", []), "um, hello");
});

test("exposes the default filler list", async () => {
  const { DEFAULT_FILLER_WORDS } = await load();
  assert.ok(Array.isArray(DEFAULT_FILLER_WORDS));
  assert.ok(DEFAULT_FILLER_WORDS.includes("um"));
  assert.ok(DEFAULT_FILLER_WORDS.includes("hmm"));
});

test("keeps the sentence stop before a filler and re-capitalises after it", async () => {
  const { removeFillerWords } = await load();
  assert.equal(
    removeFillerWords("That sucks. Uh the old app used to take those out."),
    "That sucks. The old app used to take those out."
  );
  assert.equal(removeFillerWords("Okay. Um, so the plan."), "Okay. So the plan.");
});

test("a real stop after a mid-sentence filler stays with the words before it", async () => {
  const { removeFillerWords } = await load();
  assert.equal(removeFillerWords("It is wide, hmm?"), "It is wide?");
  assert.equal(removeFillerWords("does it, um... work"), "does it work");
});
