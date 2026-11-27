const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/splitAtSentenceEnds.ts");
const words = (text) => text.split(/\s+/).filter(Boolean);

test("text within the limit is returned whole and untouched", async () => {
  const { splitAtSentenceEnds } = await load();
  const text = "  One sentence here.\n\nAnother one.  ";
  assert.deepEqual(splitAtSentenceEnds(text, 10), [text]);
  assert.deepEqual(splitAtSentenceEnds("", 10), [""]);
});

test("long text is cut at sentence ends, never mid-sentence", async () => {
  const { splitAtSentenceEnds } = await load();
  const sentences = [
    "The first sentence has six words.",
    "Is the second one a question?",
    "The third ends loudly!",
    'She said "stop here."',
    "Then a final closing sentence follows.",
  ];
  const chunks = splitAtSentenceEnds(sentences.join(" "), 12);
  assert.deepEqual(chunks, [
    `${sentences[0]} ${sentences[1]}`,
    `${sentences[2]} ${sentences[3]}`,
    sentences[4],
  ]);
  for (const chunk of chunks) assert.ok(words(chunk).length <= 12, chunk);
});

test("no word is lost or reordered", async () => {
  const { splitAtSentenceEnds } = await load();
  const text = Array.from({ length: 200 }, (_, i) => `Sentence ${i} has five words.`).join(" ");
  const chunks = splitAtSentenceEnds(text, 600);
  assert.ok(chunks.length > 1);
  assert.deepEqual(words(chunks.join(" ")), words(text));
  for (const chunk of chunks) {
    assert.ok(words(chunk).length <= 600);
    assert.match(chunk, /\.$/);
  }
});

test("a sentence longer than the limit is cut between words", async () => {
  const { splitAtSentenceEnds } = await load();
  // Speech-to-text often returns one unpunctuated run.
  const text = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ");
  const chunks = splitAtSentenceEnds(`Short start. ${text}`, 10);
  assert.deepEqual(words(chunks.join(" ")), words(`Short start. ${text}`));
  for (const chunk of chunks) assert.ok(words(chunk).length <= 10, chunk);
});

test("a decimal point inside a sentence is not a sentence end", async () => {
  const { splitAtSentenceEnds } = await load();
  const chunks = splitAtSentenceEnds(
    "Version 3.5 costs $4.20 today. Next sentence starts here now.",
    6
  );
  assert.deepEqual(chunks, ["Version 3.5 costs $4.20 today.", "Next sentence starts here now."]);
});
