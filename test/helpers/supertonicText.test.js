const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkText, preprocessText, textToIds } = require("../../src/workers/supertonicText");

test("wraps the text in its language tags and closes an open sentence", () => {
  assert.equal(preprocessText("Hello there", "en"), "<en>Hello there.</en>");
  assert.equal(preprocessText("Really?", "en"), "<en>Really?</en>");
  assert.equal(preprocessText("  ", "en"), "<en></en>");
});

test("rewrites what the model can't read", () => {
  assert.equal(
    preprocessText("It’s “fine” — mail sam@example.test", "en"),
    '<en>It\'s "fine" - mail sam at example.test.</en>'
  );
  assert.equal(
    preprocessText("Use tools, e.g., a hammer", "en"),
    "<en>Use tools, for example, a hammer.</en>"
  );
  assert.equal(preprocessText("one / two # three", "en"), "<en>one two three.</en>");
});

test("drops emoji and tidies spacing around punctuation", () => {
  assert.equal(preprocessText("Done \u{1F600}!", "en"), "<en>Done!</en>");
  assert.equal(preprocessText("a   b\n\tc ,d", "en"), "<en>a b c,d.</en>");
  assert.equal(preprocessText('say ""hi""', "en"), '<en>say "hi"</en>');
});

test("looks up each decomposed character in the indexer", () => {
  const indexer = new Int32Array(0x10000).fill(-1);
  for (const char of "<en>/e.") indexer[char.codePointAt(0)] = char.codePointAt(0);
  indexer[0x0301] = 7;
  const ids = textToIds("é", "en", indexer);
  // "é" reaches the model as "e" plus its combining accent.
  assert.deepEqual(ids.slice(4, 6), ["e".codePointAt(0), 7]);
});

test("keeps short sentences together and starts a new chunk at the limit", () => {
  assert.deepEqual(chunkText("One. Two. Three.", 300), ["One.Two.Three."]);
  assert.deepEqual(chunkText("Alpha beta. Gamma delta.", 12), ["Alpha beta.", "Gamma delta."]);
});

test("cuts a long sentence at the last space before the limit", () => {
  const chunks = chunkText("word ".repeat(100).trim(), 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(Array.from(chunk).length <= 50, chunk);
  assert.equal(chunks.join(" "), "word ".repeat(100).trim());
});

test("an empty text has no chunks", () => {
  assert.deepEqual(chunkText(" \n ", 300), []);
});
