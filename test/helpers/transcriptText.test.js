const test = require("node:test");
const assert = require("node:assert/strict");

const { transcriptsOverlap, transcriptsLooselyOverlap } = require("../../src/helpers/transcriptText");

test("transcriptsOverlap matches near-duplicate meeting transcripts", () => {
  assert.equal(
    transcriptsOverlap(
      "a distribution mechanism? Is it a future product? Is it one of N ways people are",
      "mechanism as a future product? Is it one of the ways we are going to interact wi"
    ),
    true
  );

  assert.equal(
    transcriptsOverlap(
      "with the world? I feel like in search with every shift, you're able to do more w",
      "I feel like in search with every step you're able to do more."
    ),
    true
  );
});

test("transcriptsOverlap stays conservative for short generic fragments", () => {
  assert.equal(transcriptsOverlap("and you know we have", "you know, be a..."), false);
  assert.equal(transcriptsOverlap("Thank you.", "Thanks."), false);
});

test("transcriptsLooselyOverlap catches chunk-boundary paraphrases without matching filler", () => {
  assert.equal(
    transcriptsLooselyOverlap(
      "or just information-seeking queries, will be agent-taken search, You'll be completing tasks, you'll have many threads running. Well, search exist",
      "The inquiry will be agent in search. You will be completing"
    ),
    true
  );

  assert.equal(
    transcriptsLooselyOverlap(
      "You'll be completing tasks, you'll have many threads running. Well, search exist in 10 years? Well, you know, you may... Or it just evolves into something else.",
      "I don't see that many threads running. So, it takes us 10 years? What?"
    ),
    true
  );

  assert.equal(transcriptsLooselyOverlap("and you know we have", "you know, be a..."), false);
});
