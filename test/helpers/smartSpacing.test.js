const test = require("node:test");
const assert = require("node:assert/strict");

const { applySmartSpacing } = require("../../src/helpers/smartSpacing");

test("adds trailing space to normal text", () => {
  assert.equal(applySmartSpacing("hello"), "hello ");
});

test("adds trailing space after punctuation", () => {
  assert.equal(applySmartSpacing("hello."), "hello. ");
  assert.equal(applySmartSpacing("hello!"), "hello! ");
});

test("does not double-up when text already ends with whitespace", () => {
  assert.equal(applySmartSpacing("hello "), "hello ");
  assert.equal(applySmartSpacing("hello\n"), "hello\n");
  assert.equal(applySmartSpacing("hello\t"), "hello\t");
});

test("handles empty transcript", () => {
  assert.equal(applySmartSpacing(""), "");
});

test("returns non-string input unchanged", () => {
  assert.equal(applySmartSpacing(null), null);
  assert.equal(applySmartSpacing(undefined), undefined);
});
