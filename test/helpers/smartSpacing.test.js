const test = require("node:test");
const assert = require("node:assert/strict");

const { applySmartSpacing } = require("../../src/helpers/smartSpacing");

const prepend = (text, precedingChar) =>
  applySmartSpacing({ text, mode: "prepend", precedingChar });

const append = (text) => applySmartSpacing({ text, mode: "append" });

test("prepend: adds space after a regular letter", () => {
  assert.equal(prepend("hello", "d"), " hello");
});

test("prepend: adds space after a digit", () => {
  assert.equal(prepend("dollars", "5"), " dollars");
});

test("prepend: no space at field start (empty precedingChar)", () => {
  assert.equal(prepend("hello", ""), "hello");
});

test("prepend: no space when precedingChar is null/undefined", () => {
  assert.equal(prepend("hello", null), "hello");
  assert.equal(prepend("hello", undefined), "hello");
});

test("prepend: no space after existing whitespace", () => {
  assert.equal(prepend("hello", " "), "hello");
  assert.equal(prepend("hello", "\t"), "hello");
  assert.equal(prepend("hello", "\n"), "hello");
});

test("prepend: no space after opening brackets", () => {
  assert.equal(prepend("hello", "("), "hello");
  assert.equal(prepend("hello", "["), "hello");
  assert.equal(prepend("hello", "{"), "hello");
  assert.equal(prepend("hello", "<"), "hello");
});

test("prepend: no space after opening quotes", () => {
  assert.equal(prepend("hello", '"'), "hello");
  assert.equal(prepend("hello", "'"), "hello");
  assert.equal(prepend("hello", "`"), "hello");
  assert.equal(prepend("hello", "“"), "hello");
});

test("prepend: no space when transcript already starts with whitespace", () => {
  assert.equal(prepend(" hello", "d"), " hello");
  assert.equal(prepend("\nhello", "d"), "\nhello");
});

test("prepend: no space when transcript starts with closing punctuation", () => {
  // "Hello" + ", world" → "Hello, world" (not "Hello , world")
  assert.equal(prepend(", world", "o"), ", world");
  assert.equal(prepend(". Period.", "o"), ". Period.");
  assert.equal(prepend("! exclamation", "o"), "! exclamation");
  assert.equal(prepend("? question", "o"), "? question");
  assert.equal(prepend("; semicolon", "o"), "; semicolon");
  assert.equal(prepend(": colon", "o"), ": colon");
  assert.equal(prepend(") close paren", "o"), ") close paren");
  assert.equal(prepend("，世界", "好"), "，世界");
  assert.equal(prepend("。句号", "好"), "。句号");
  assert.equal(prepend("！感叹", "好"), "！感叹");
  assert.equal(prepend("？问号", "好"), "？问号");
  assert.equal(prepend("；分号", "好"), "；分号");
  assert.equal(prepend("：冒号", "好"), "：冒号");
  assert.equal(prepend("）右括号", "好"), "）右括号");
  assert.equal(prepend("】右方括号", "好"), "】右方括号");
  assert.equal(prepend("》右书名号", "好"), "》右书名号");
  assert.equal(prepend("、顿号", "好"), "、顿号");
});

test("prepend: no space after multi-char whitespace or CRLF newlines", () => {
  assert.equal(prepend("hello", "\r\n"), "hello");
  assert.equal(prepend("hello", "  "), "hello");
  assert.equal(prepend("hello", "\t\t"), "hello");
});

test("prepend: no space after full-width CJK opening brackets", () => {
  assert.equal(prepend("内容", "（"), "内容");
  assert.equal(prepend("内容", "【"), "内容");
  assert.equal(prepend("内容", "《"), "内容");
  assert.equal(prepend("内容", "「"), "内容");
  assert.equal(prepend("内容", "『"), "内容");
});

test("prepend: adds space when preceding char is sentence punctuation (no space yet)", () => {
  assert.equal(prepend("World", "."), " World");
  assert.equal(prepend("World", "!"), " World");
  assert.equal(prepend("World", "?"), " World");
});

test("prepend: no space when preceding is whitespace, even after period+space sequence", () => {
  assert.equal(prepend("World", " "), "World");
});

test("prepend: handles unicode preceding chars", () => {
  assert.equal(prepend("hello", "д"), " hello");
});

test("prepend: handles empty transcript", () => {
  assert.equal(prepend("", "a"), "");
});

test("append: adds trailing space to normal text", () => {
  assert.equal(append("hello"), "hello ");
});

test("append: adds trailing space after punctuation", () => {
  assert.equal(append("hello."), "hello. ");
  assert.equal(append("hello!"), "hello! ");
});

test("append: does not double-up when text already ends with whitespace", () => {
  assert.equal(append("hello "), "hello ");
  assert.equal(append("hello\n"), "hello\n");
  assert.equal(append("hello\t"), "hello\t");
});

test("append: handles empty transcript", () => {
  assert.equal(append(""), "");
});

test("returns text unchanged for unknown mode", () => {
  assert.equal(applySmartSpacing({ text: "hello", mode: "noop" }), "hello");
});

test("returns text unchanged for non-string input", () => {
  assert.equal(applySmartSpacing({ text: null, mode: "append" }), null);
  assert.equal(applySmartSpacing({ text: undefined, mode: "append" }), undefined);
});

test("integration: typical dictation flow", () => {
  // Field starts empty: "" → "Hello there"
  assert.equal(prepend("Hello there.", ""), "Hello there.");

  // After append fallback, next paste's preceding char is " "
  // Field: "Hello there. " → user dictates again
  assert.equal(prepend("How are you?", " "), "How are you?");

  // No fallback was used; preceding char is "."
  assert.equal(prepend("How are you?", "."), " How are you?");

  // User dictates a closing tag: "(" → "first part)"
  assert.equal(prepend("first part)", "("), "first part)");
});
