const test = require("node:test");
const assert = require("node:assert/strict");

const { applyContinuationCasing } = require("../../src/helpers/smartSpacing");

test("unknown context (null/undefined) leaves the text alone", () => {
  assert.equal(applyContinuationCasing("Hello there", null), "Hello there");
  assert.equal(applyContinuationCasing("Hello there", undefined), "Hello there");
});

test("empty tail (field start) capitalizes a lowercase start", () => {
  assert.equal(applyContinuationCasing("hello there", ""), "Hello there");
  assert.equal(applyContinuationCasing("Hello there", ""), "Hello there");
});

test("mid-sentence continuation lowercases the automatic leading capital", () => {
  assert.equal(applyContinuationCasing("And then we left", "so we packed up "), "and then we left");
  assert.equal(applyContinuationCasing("Because it rained", "we stayed in,"), "because it rained");
});

test("sentence-ending punctuation keeps or restores the capital", () => {
  assert.equal(applyContinuationCasing("It was late", "We gave up."), "It was late");
  assert.equal(applyContinuationCasing("it was late", "We gave up. "), "It was late");
  assert.equal(applyContinuationCasing("Really", "Did it work?"), "Really");
  assert.equal(applyContinuationCasing("What a day", "Wow!"), "What a day");
  assert.equal(applyContinuationCasing("first, do this", "The steps:"), "First, do this");
});

test("closers after the ender still count as a sentence end", () => {
  assert.equal(applyContinuationCasing("Then he left", 'she said "stop."'), "Then he left");
  assert.equal(applyContinuationCasing("Then he left", "a note (done.)"), "Then he left");
});

test("a line break starts a new line even without punctuation", () => {
  assert.equal(applyContinuationCasing("second point", "first point\n"), "Second point");
  assert.equal(applyContinuationCasing("second point", "- first point\n\t"), "Second point");
});

test("the pronoun I and its contractions keep their capital", () => {
  assert.equal(applyContinuationCasing("I think so", "and then "), "I think so");
  assert.equal(applyContinuationCasing("I'm not sure", "but "), "I'm not sure");
  assert.equal(applyContinuationCasing("I’ll check", "later "), "I’ll check");
});

test("acronyms keep their capitals mid-sentence", () => {
  assert.equal(applyContinuationCasing("AI is everywhere", "these days "), "AI is everywhere");
  assert.equal(applyContinuationCasing("VAT applies here", "note that "), "VAT applies here");
});

test("comma or word before the cursor means continuation", () => {
  assert.equal(applyContinuationCasing("The report is due", "as discussed, "), "the report is due");
  assert.equal(applyContinuationCasing("Send it over", "please "), "send it over");
});

test("non-letter and empty inputs are untouched", () => {
  assert.equal(applyContinuationCasing("", "text "), "");
  assert.equal(applyContinuationCasing("123 go", "then "), "123 go");
  assert.equal(applyContinuationCasing(null, "then "), null);
});
