const test = require("node:test");
const assert = require("node:assert/strict");

async function loadMerge() {
  const { mergeStreamingTranscript } = await import("../../src/helpers/streamingTranscript.js");
  return mergeStreamingTranscript;
}

test("a trailing partial is kept when earlier turns already finalized", async () => {
  const mergeStreamingTranscript = await loadMerge();
  assert.equal(
    mergeStreamingTranscript("The first sentence.", "and the last ten seconds"),
    "The first sentence. and the last ten seconds"
  );
});

test("an empty side does not invent separators", async () => {
  const mergeStreamingTranscript = await loadMerge();
  assert.equal(mergeStreamingTranscript("done.", ""), "done.");
  assert.equal(mergeStreamingTranscript("", "only partial"), "only partial");
  assert.equal(mergeStreamingTranscript("", ""), "");
});

test("a partial that is already inside the committed text is not duplicated", async () => {
  const mergeStreamingTranscript = await loadMerge();
  assert.equal(
    mergeStreamingTranscript("The quick brown fox.", "brown fox."),
    "The quick brown fox."
  );
  assert.equal(
    mergeStreamingTranscript("The quick brown fox.", "The quick brown fox."),
    "The quick brown fox."
  );
});

test("a revised partial that contains the committed prefix replaces it", async () => {
  const mergeStreamingTranscript = await loadMerge();
  assert.equal(
    mergeStreamingTranscript("The quick brown", "The quick brown fox jumped"),
    "The quick brown fox jumped"
  );
});
