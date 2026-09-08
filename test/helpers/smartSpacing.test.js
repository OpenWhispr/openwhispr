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

test("does not append a trailing space after CJK ideographs", () => {
  assert.equal(applySmartSpacing("你好"), "你好");
  assert.equal(applySmartSpacing("日本語"), "日本語");
});

test("does not append a trailing space after kana", () => {
  assert.equal(applySmartSpacing("こんにちは"), "こんにちは");
  assert.equal(applySmartSpacing("カタカナ"), "カタカナ");
});

test("does not append a trailing space after full-width punctuation", () => {
  assert.equal(applySmartSpacing("你好。"), "你好。");
  assert.equal(applySmartSpacing("すごい！"), "すごい！");
  assert.equal(applySmartSpacing("何？"), "何？");
  assert.equal(applySmartSpacing("はい、"), "はい、");
  assert.equal(applySmartSpacing("「引用」"), "「引用」");
  assert.equal(applySmartSpacing("（括弧）"), "（括弧）");
});

test("does not append a trailing space after halfwidth CJK punctuation and vertical forms", () => {
  assert.equal(applySmartSpacing("ﾃｽﾄ｡"), "ﾃｽﾄ｡");
  assert.equal(applySmartSpacing("你好︒"), "你好︒");
});

test("uses the last character for mixed-script text", () => {
  assert.equal(applySmartSpacing("hello 你好"), "hello 你好");
  assert.equal(applySmartSpacing("你好 hello"), "你好 hello ");
});

test("keeps trailing spaces after Hangul because Korean uses word spacing", () => {
  assert.equal(applySmartSpacing("안녕하세요"), "안녕하세요 ");
});

test("returns non-string input unchanged", () => {
  assert.equal(applySmartSpacing(null), null);
  assert.equal(applySmartSpacing(undefined), undefined);
});
