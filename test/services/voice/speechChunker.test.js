const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/speechChunker.ts");

const pushAll = (chunker, deltas) => deltas.flatMap((delta) => chunker.push(delta));

test("emits a sentence as soon as its terminator is followed by whitespace", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 1000 });
  assert.deepEqual(pushAll(chunker, ["You have two ", "meetings.", " The first"]), [
    "You have two meetings.",
  ]);
  assert.deepEqual(chunker.flush(), ["The first"]);
});

test("the first chunk may break at a clause once it is long enough, later chunks may not", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 20 });
  const out = pushAll(chunker, [
    "Tomorrow looks fairly busy for you, ",
    "with a design review at ten, and a one-on-one at two. ",
  ]);
  assert.deepEqual(out, [
    "Tomorrow looks fairly busy for you,",
    "with a design review at ten, and a one-on-one at two.",
  ]);
});

test("a clause shorter than the first-chunk minimum does not split", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 20 });
  assert.deepEqual(pushAll(chunker, ["Sure, one moment. "]), ["Sure, one moment."]);
});

test("does not split decimals or lowercase continuations after abbreviations", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 1000 });
  assert.deepEqual(pushAll(chunker, ["Version 3.5 shipped, e.g. last week. Next"]), [
    "Version 3.5 shipped, e.g. last week.",
  ]);
});

test("splits on newlines and question or exclamation marks", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 1000 });
  assert.deepEqual(pushAll(chunker, ["Done!\nWant more? Okay"]), ["Done!", "Want more?"]);
  assert.deepEqual(chunker.flush(), ["Okay"]);
});

test("forces a split at the last space once a chunk exceeds the maximum length", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({
    firstChunkMinChars: 1000,
    maxChunkChars: 20,
    maxFirstChunkChars: 20,
  });
  assert.deepEqual(pushAll(chunker, ["one two three four five six seven"]), [
    "one two three four",
  ]);
  assert.deepEqual(chunker.flush(), ["five six seven"]);
});

test("a long first sentence with no punctuation is cut at a space so speech can start", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 24, maxFirstChunkChars: 40 });
  const out = pushAll(chunker, ["The weather in Tokyo right now is mostly sunny with light winds from the east"]);
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= 40);
  assert.ok(!out[0].endsWith(" "));
  // Later chunks keep waiting for real sentence boundaries.
  assert.deepEqual(pushAll(chunker, [" and a high of twenty"]), []);
});

test("stops emitting after the spoken-sentence limit, until reset", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 1000, maxChunks: 2 });
  assert.deepEqual(pushAll(chunker, ["One. Two. Three. Four. "]), ["One.", "Two."]);
  assert.deepEqual(chunker.flush(), []);
  chunker.reset();
  assert.deepEqual(pushAll(chunker, ["Fresh start. "]), ["Fresh start."]);
});

test("strips markdown and drops chunks with nothing speakable", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 1000 });
  const out = pushAll(chunker, [
    "## Summary\n",
    "- **Design review** at `10:00`.\n",
    "See [the notes](https://example.com/notes) or https://example.com/x for more.\n",
    "---\n",
  ]);
  assert.deepEqual(out, [
    "Summary",
    "Design review at 10:00.",
    "See the notes or a link for more.",
  ]);
});

test("reset discards buffered text and restores first-chunk behaviour", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker({ firstChunkMinChars: 10 });
  pushAll(chunker, ["This will be dropped, entirely"]);
  chunker.reset();
  assert.deepEqual(chunker.flush(), []);
  assert.deepEqual(pushAll(chunker, ["A fresh answer here, "]), ["A fresh answer here,"]);
});

test("toSpeakableText leaves plain text untouched", async () => {
  const { toSpeakableText } = await load();
  assert.equal(toSpeakableText("Plain sentence, nothing else."), "Plain sentence, nothing else.");
});
