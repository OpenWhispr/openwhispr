const { test, describe } = require("node:test");
const assert = require("node:assert");
const {
  extractAnthropicText,
  describeMissingAnthropicText,
} = require("../../src/helpers/anthropicResponse.js");

describe("extractAnthropicText", () => {
  test("returns trimmed text for a normal single text block", () => {
    const data = { content: [{ type: "text", text: "  cleaned up dictation  " }] };
    assert.strictEqual(extractAnthropicText(data), "cleaned up dictation");
  });

  test("joins multiple text blocks", () => {
    const data = {
      content: [
        { type: "text", text: "first " },
        { type: "text", text: "second" },
      ],
    };
    assert.strictEqual(extractAnthropicText(data), "first second");
  });

  test("skips leading thinking block and returns the text block (#1653)", () => {
    const data = {
      content: [
        { type: "thinking", thinking: "let me consider..." },
        { type: "text", text: "the answer" },
      ],
    };
    assert.strictEqual(extractAnthropicText(data), "the answer");
  });

  test("returns null when content is empty (max_tokens before any text)", () => {
    assert.strictEqual(extractAnthropicText({ content: [], stop_reason: "max_tokens" }), null);
  });

  test("returns null when content has only non-text blocks", () => {
    const data = { content: [{ type: "thinking", thinking: "..." }] };
    assert.strictEqual(extractAnthropicText(data), null);
  });

  test("returns null for missing or malformed content", () => {
    assert.strictEqual(extractAnthropicText({}), null);
    assert.strictEqual(extractAnthropicText(null), null);
    assert.strictEqual(extractAnthropicText({ content: "nope" }), null);
    assert.strictEqual(extractAnthropicText({ content: [{ type: "text" }] }), null);
  });

  test("preserves empty-string success for an all-whitespace text block", () => {
    const data = { content: [{ type: "text", text: "   " }] };
    assert.strictEqual(extractAnthropicText(data), "");
  });

  test("pre-fix expression throws on the shapes this helper now handles", () => {
    // The old handler read data.content[0].text.trim() directly; these are the
    // response shapes from #1653 that made it throw the reported TypeError.
    const shapes = [
      { content: [], stop_reason: "max_tokens" },
      { content: [{ type: "thinking", thinking: "..." }] },
    ];
    for (const data of shapes) {
      assert.throws(() => data.content[0].text.trim(), TypeError);
      assert.doesNotThrow(() => extractAnthropicText(data));
    }
  });
});

describe("describeMissingAnthropicText", () => {
  test("names max_tokens explicitly", () => {
    assert.match(describeMissingAnthropicText({ stop_reason: "max_tokens" }), /max_tokens limit/);
  });

  test("includes other stop reasons", () => {
    assert.match(describeMissingAnthropicText({ stop_reason: "refusal" }), /refusal/);
  });

  test("falls back to a generic message", () => {
    assert.strictEqual(
      describeMissingAnthropicText({}),
      "Anthropic response contained no text content"
    );
  });
});
