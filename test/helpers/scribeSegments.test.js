const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/scribeSegments.js");

const word = (text, start, end, speaker_id = "speaker_0") => ({
  text,
  start,
  end,
  type: "word",
  speaker_id,
});
const spacing = (start, end, text = " ") => ({
  text,
  start,
  end,
  type: "spacing",
  speaker_id: null,
});

test("request fields: model_id, diarize flag, word timestamps, never language_code", async () => {
  const { scribeRequestFields } = await load();

  assert.deepEqual(scribeRequestFields({ model: "parakeet-unified-en-0.6b", diarize: true }), {
    model_id: "parakeet-unified-en-0.6b",
    diarize: "true",
    timestamps_granularity: "word",
  });
  const off = scribeRequestFields({ model: "m", diarize: false });
  assert.equal(off.diarize, "false");
  assert.equal("language_code" in off, false);
  assert.equal(scribeRequestFields({ diarize: true }).model_id, "scribe");
});

test("one speaker with small gaps becomes one segment with first start and last end", async () => {
  const { scribeWordsToSegments } = await load();

  const segments = scribeWordsToSegments([
    word("hello", 0.1, 0.5),
    spacing(0.5, 0.6),
    word("there", 0.6, 1.0),
    word("friend", 1.2, 1.8),
  ]);

  assert.deepEqual(segments, [
    { speaker: "speaker_0", text: "hello there friend", start: 0.1, end: 1.8 },
  ]);
});

test("the original spacing between words is kept", async () => {
  const { scribeWordsToSegments } = await load();

  const segments = scribeWordsToSegments([
    word("a", 0, 0.2),
    spacing(0.2, 0.3, "  "),
    word("b", 0.3, 0.5),
  ]);
  assert.equal(segments[0].text, "a  b");
});

test("a speaker change starts a new segment", async () => {
  const { scribeWordsToSegments } = await load();

  const segments = scribeWordsToSegments([
    word("hi", 0, 0.4, "speaker_0"),
    word("there", 0.5, 0.9, "speaker_0"),
    word("hello", 1.0, 1.4, "speaker_1"),
    word("back", 1.5, 1.9, "speaker_0"),
  ]);

  assert.deepEqual(
    segments.map((s) => [s.speaker, s.text, s.start, s.end]),
    [
      ["speaker_0", "hi there", 0, 0.9],
      ["speaker_1", "hello", 1.0, 1.4],
      ["speaker_0", "back", 1.5, 1.9],
    ]
  );
});

test("a gap over 1.5 s between words of one speaker starts a new segment", async () => {
  const { scribeWordsToSegments } = await load();

  const split = scribeWordsToSegments([word("one", 0, 0.5), word("two", 2.2, 2.6)]);
  assert.equal(split.length, 2);

  const kept = scribeWordsToSegments([word("one", 0, 0.5), word("two", 2.0, 2.4)]);
  assert.equal(kept.length, 1, "a gap of exactly 1.5 s stays in the segment");
});

test("a segment over 30 s splits after the next sentence-final word", async () => {
  const { scribeWordsToSegments } = await load();

  const words = [];
  for (let i = 0; i < 40; i++) words.push(word(i === 36 ? "done." : `w${i}`, i, i + 0.9));
  const segments = scribeWordsToSegments(words);

  // Past 30 s the split waits for "done." (index 36), not the 31st word.
  assert.equal(segments.length, 2);
  assert.ok(segments[0].text.endsWith("done."));
  assert.equal(segments[0].end, 36.9);
  assert.equal(segments[1].text, "w37 w38 w39");

  const short = scribeWordsToSegments([word("quick.", 0, 0.5), word("again.", 0.6, 1.1)]);
  assert.equal(short.length, 1, "sentence-final punctuation alone never splits a short segment");
});

test("spacing items never start or end a segment; empty or invalid words give no segments", async () => {
  const { scribeWordsToSegments } = await load();

  assert.deepEqual(scribeWordsToSegments([]), []);
  assert.deepEqual(scribeWordsToSegments(undefined), []);
  assert.deepEqual(scribeWordsToSegments([spacing(0, 1), spacing(1, 2)]), []);

  const segments = scribeWordsToSegments([
    spacing(0, 0.1),
    word("alone", 0.1, 0.5),
    spacing(0.5, 0.9),
  ]);
  assert.deepEqual(segments, [{ speaker: "speaker_0", text: "alone", start: 0.1, end: 0.5 }]);

  // Server-controlled input: words without numeric times or string text are dropped.
  const dirty = scribeWordsToSegments([
    { type: "word", text: "no-times", speaker_id: "speaker_0" },
    { type: "word", text: 42, start: 0, end: 1, speaker_id: "speaker_0" },
    { type: "word", text: "  ", start: 0, end: 1, speaker_id: "speaker_0" },
    null,
    word("ok", 1, 1.5),
  ]);
  assert.deepEqual(dirty, [{ speaker: "speaker_0", text: "ok", start: 1, end: 1.5 }]);
});

test("a missing speaker_id (diarize off) gives segments without a speaker field", async () => {
  const { scribeWordsToSegments } = await load();

  const segments = scribeWordsToSegments([
    word("plain", 0, 0.4, null),
    word("text", 0.5, 0.9, null),
  ]);

  assert.deepEqual(segments, [{ text: "plain text", start: 0, end: 0.9 }]);
  assert.equal("speaker" in segments[0], false);
});
