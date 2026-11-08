const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/speechChunker.ts");

const pushAll = (chunker, deltas) => deltas.flatMap((delta) => chunker.push(delta));

test("emits a sentence as soon as its terminator is followed by whitespace", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  assert.deepEqual(pushAll(chunker, ["You have two ", "meetings.", " The first"]), [
    "You have two meetings.",
  ]);
  assert.deepEqual(chunker.flush(), ["The first"]);
});

test("only a long first chunk may stop at a clause, and no chunk is cut for its length", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  const out = pushAll(chunker, [
    "Sure, high above the misty peaks of the Ember Range, a dragon named Cinder ",
    "baked bread. Every morning, before the sun rose over the valley, she lit her oven. ",
  ]);
  assert.deepEqual(out, [
    "Sure, high above the misty peaks of the Ember Range,",
    "a dragon named Cinder baked bread.",
    "Every morning, before the sun rose over the valley, she lit her oven.",
  ]);
  const unpunctuated = createSpeechChunker();
  assert.deepEqual(
    pushAll(unpunctuated, ["The weather in Tokyo right now is mostly sunny with light winds "]),
    []
  );
});

test("a Hindi sentence ends at its danda", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  assert.deepEqual(pushAll(chunker, ["कल दो मीटिंग हैं। पहली नौ बजे"]), ["कल दो मीटिंग हैं।"]);
});

test("does not split decimals or lowercase continuations after abbreviations", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  assert.deepEqual(pushAll(chunker, ["Version 3.5 shipped, e.g. last week. Next"]), [
    "Version 3.5 shipped, e.g. last week.",
  ]);
});

test("a numbered list item is one chunk, not its number and then its text", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  assert.deepEqual(
    pushAll(chunker, ["1. Keep a set bedtime.\n2. Dim the lights.\n", "3. Skip late coffee.\n"]),
    ["Keep a set bedtime.", "Dim the lights.", "Skip late coffee."]
  );
});

test("splits on newlines and question or exclamation marks", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  assert.deepEqual(pushAll(chunker, ["Done!\nWant more? Okay"]), ["Done!", "Want more?"]);
  assert.deepEqual(chunker.flush(), ["Okay"]);
});

test("strips markdown, skips headings and drops chunks with nothing speakable", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  const out = pushAll(chunker, [
    "## Founding and Kingdom (753 BC – 509 BC)\n",
    "**Inner Planets**  \n",
    "- **Design review** at `10:00`.\n",
    "• Open Settings → Profile.\n",
    "See [the notes](https://example.com/notes) or https://example.com/x for more.\n",
    "Join at https://user:tok3n@meet.example.com:8443?pwd=Xy12ab today.\n",
    "---\n",
  ]);
  assert.deepEqual(out, [
    "Design review at 10:00.",
    "Open Settings, Profile.",
    "See the notes or example.com for more.",
    "Join at meet.example.com today.",
  ]);
});

test("reset discards buffered text", async () => {
  const { createSpeechChunker } = await load();
  const chunker = createSpeechChunker();
  pushAll(chunker, ["This will be dropped, entirely"]);
  chunker.reset();
  assert.deepEqual(chunker.flush(), []);
  assert.deepEqual(pushAll(chunker, ["A fresh answer here. "]), ["A fresh answer here."]);
});

test("toSpeakableText leaves plain text untouched", async () => {
  const { toSpeakableText } = await load();
  assert.equal(toSpeakableText("Plain sentence, nothing else."), "Plain sentence, nothing else.");
});
