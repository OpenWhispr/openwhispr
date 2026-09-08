const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/liveTranscriptPresentation.ts");

test("short live transcript keeps the whole active phrase shimmering", async () => {
  const { splitTranscriptForShimmer } = await load();

  assert.deepEqual(splitTranscriptForShimmer("A short live phrase", 6), {
    settled: "",
    active: "A short live phrase",
  });
});

test("long live transcript shimmers only its trailing phrase", async () => {
  const { splitTranscriptForShimmer } = await load();
  const text = "one two three four five six seven eight nine ten";

  assert.deepEqual(splitTranscriptForShimmer(text, 4), {
    settled: "one two three four five six ",
    active: "seven eight nine ten",
  });
});

test("empty live transcript has no shimmer parts", async () => {
  const { splitTranscriptForShimmer } = await load();

  assert.deepEqual(splitTranscriptForShimmer("   "), { settled: "", active: "" });
});

test("default shimmer work stays bounded to the newest six words", async () => {
  const { splitTranscriptForShimmer } = await load();

  assert.deepEqual(splitTranscriptForShimmer("one two three four five six seven eight"), {
    settled: "one two ",
    active: "three four five six seven eight",
  });
});

// Task 10: the opacity-only tail. The stepped background-clip shimmer is
// replaced by per-word spans whose ABSOLUTE word index is the React key, so a
// word keeps its DOM node (and therefore its running opacity transition) as
// the transcript grows around it. `active` is the newest window at 62%;
// the `settlingWordCount` words behind it stay individually rendered purely so
// that 62% -> 100% can TRANSITION rather than step when a word leaves the
// active window.

test("the tail keeps stable word indices, six active words and six settling words", async () => {
  const { splitTranscriptForTail } = await load();
  const words = Array.from({ length: 15 }, (_, i) => `w${i}`);
  const result = splitTranscriptForTail(words.join(" "));
  assert.equal(result.settled, "w0 w1 w2 ");
  assert.deepEqual(
    result.tail.map((w) => w.index),
    [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
  );
  assert.deepEqual(
    result.tail.map((w) => w.active),
    [false, false, false, false, false, false, true, true, true, true, true, true]
  );
  assert.equal(result.tail.at(-1).text, "w14");
});

test("a short transcript is all tail; an empty one is nothing", async () => {
  const { splitTranscriptForTail } = await load();
  const short = splitTranscriptForTail("just four words here");
  assert.equal(short.settled, "");
  assert.deepEqual(
    short.tail.map((w) => w.active),
    [true, true, true, true]
  );
  assert.deepEqual(splitTranscriptForTail("   "), { settled: "", tail: [] });
});

// A GROWING tail is the streaming case: a delta appends words, the active
// window slides forward, and every word that was already rendered must keep
// the SAME index so React keeps its span (and its in-flight opacity
// transition) instead of remounting it at the new opacity.
test("a growing tail slides the active window forward without renumbering the words already rendered", async () => {
  const { splitTranscriptForTail } = await load();
  const words = Array.from({ length: 14 }, (_, i) => `w${i}`);
  const before = splitTranscriptForTail(words.slice(0, 13).join(" "));
  const after = splitTranscriptForTail(words.join(" "));

  const indexOf = (result, text) => result.tail.find((word) => word.text === text)?.index;
  for (const word of ["w6", "w9", "w12"]) {
    assert.equal(
      indexOf(before, word),
      indexOf(after, word),
      `${word} must keep its absolute index across the delta — the index IS the React key`
    );
  }
  // w7 was the oldest active word of the 13; the delta pushes it out of the
  // active window, which is the 62% -> 100% settle this task exists for.
  assert.equal(before.tail.find((word) => word.text === "w7").active, true);
  assert.equal(after.tail.find((word) => word.text === "w7").active, false);
  assert.equal(after.tail.at(-1).text, "w13");
  assert.equal(after.tail.at(-1).active, true);
});

// A COMMITTING tail is what the panel renders once the transcript stops
// streaming (phase "final"/"cleanup" done): activeWordCount 0 leaves every
// word in the tail but marks none active, so the last six words transition
// 62% -> 100% instead of snapping when their spans are replaced by one
// settled string.
test("a committing tail keeps the same word spans and only drops `active`", async () => {
  const { splitTranscriptForTail } = await load();
  const words = Array.from({ length: 15 }, (_, i) => `w${i}`).join(" ");
  const streaming = splitTranscriptForTail(words);
  const committed = splitTranscriptForTail(words, { activeWordCount: 0 });

  assert.deepEqual(
    committed.tail.map((word) => word.active),
    committed.tail.map(() => false),
    "a committed transcript has no active words left"
  );
  const stillActive = streaming.tail.filter((word) => word.active).map((word) => word.index);
  const keptKeys = new Set(committed.tail.map((word) => word.index));
  for (const index of stillActive) {
    assert.ok(
      keptKeys.has(index),
      `word ${index} was at 62% and must keep its span through the commit so the opacity can transition`
    );
  }
  assert.equal(committed.settled, "w0 w1 w2 w3 w4 w5 w6 w7 w8 ");
});

// A SHRINKING tail is the recognizer replacing its own hypothesis with a
// shorter one. The window must re-derive from the NEW length (never clamp at
// a stale offset) and must not produce negative indices.
test("a shrinking tail re-derives its window from the new length", async () => {
  const { splitTranscriptForTail } = await load();
  const long = splitTranscriptForTail(
    Array.from({ length: 15 }, (_, i) => `w${i}`).join(" ")
  );
  const short = splitTranscriptForTail("one two three");

  assert.equal(long.tail.length, 12);
  assert.equal(short.settled, "");
  assert.deepEqual(
    short.tail.map((word) => word.index),
    [0, 1, 2]
  );
  assert.ok(
    short.tail.every((word) => word.index >= 0 && word.active),
    "a transcript shorter than the active window is entirely active, with no negative indices"
  );
});

test("the tail collapses runs of whitespace and never emits an empty word", async () => {
  const { splitTranscriptForTail } = await load();
  const result = splitTranscriptForTail("  one \n two    three  ");

  assert.equal(result.settled, "");
  assert.deepEqual(
    result.tail.map((word) => word.text),
    ["one", "two", "three"]
  );
});

// Fix round 1, finding 1. The tail must carry the ACTUAL whitespace that
// separated each pair of words, not one space per gap: the transcript
// paragraph is `whitespace-pre-wrap` because the cleanup prompt asks the model
// for real line breaks, bullet lists and paragraph breaks, and the hidden node
// the panel measures its height against renders the same string RAW. The
// round-trip below is the whole contract — reassembling the parts must give
// back the source exactly.
const BREAK_SHAPES = {
  "a spoken new line": "alpha bravo charlie\nsecond line here delta echo foxtrot golf",
  "a paragraph break":
    "first paragraph opening line here\n\nsecond paragraph continues with more words and then some more to push past the window",
  "a bullet list":
    "- buy milk\n- call the dentist\n- send the invoice today\n- book the flight home tomorrow",
};

const reassemble = (result) =>
  result.settled + result.tail.map((word) => `${word.text}${word.separator}`).join("");

for (const [shape, transcript] of Object.entries(BREAK_SHAPES)) {
  test(`the tail reassembles ${shape} character for character, streaming and committed`, async () => {
    const { splitTranscriptForTail } = await load();

    assert.equal(reassemble(splitTranscriptForTail(transcript)), transcript);
    assert.equal(
      reassemble(splitTranscriptForTail(transcript, { activeWordCount: 0 })),
      transcript,
      "the commit renders the same characters as the stream — only `active` changes"
    );
  });
}

test("each tail word carries the exact whitespace that followed it, and the last carries none", async () => {
  const { splitTranscriptForTail } = await load();
  const result = splitTranscriptForTail("alpha\n\nbravo charlie\ndelta");

  assert.deepEqual(
    result.tail.map((word) => [word.text, word.separator]),
    [
      ["alpha", "\n\n"],
      ["bravo", " "],
      ["charlie", "\n"],
      ["delta", ""],
    ]
  );
});

test("the settled prefix is an exact slice of the source, breaks and all", async () => {
  const { splitTranscriptForTail } = await load();
  const transcript = BREAK_SHAPES["a paragraph break"];
  const result = splitTranscriptForTail(transcript);

  assert.ok(result.settled.length > 0, "fixture sanity: this shape is long enough to settle words");
  assert.ok(
    transcript.startsWith(result.settled),
    "the settled string must be a literal prefix of the source, not a re-joined one"
  );
  assert.match(result.settled, /\n\n/, "and it must still carry the paragraph break inside it");
});
