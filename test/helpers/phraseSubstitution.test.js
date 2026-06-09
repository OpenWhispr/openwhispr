const test = require("node:test");
const assert = require("node:assert/strict");

const phrase = (trigger, snippet, id = trigger) => ({ id, trigger, snippet });

test("substitutes a trigger in the middle of text", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("Send to my email please", [phrase("my email", "me@example.com")]),
    "Send to me@example.com please"
  );
});

test("preserves text trailing the trigger, including punctuation", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("message template one, best wishes Matt", [
      phrase("message template one", "<TEMPLATE>"),
    ]),
    "<TEMPLATE>, best wishes Matt"
  );
});

test("matches case-insensitively", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(applyPhrases("My Email rocks", [phrase("my email", "X")]), "X rocks");
});

test("respects word boundaries (plural does not match)", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("check my emails", [phrase("my email", "X")]),
    "check my emails"
  );
});

test("prefers the longest matching trigger when triggers overlap", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  const phrases = [phrase("message", "M"), phrase("message template one", "FULL")];
  assert.equal(applyPhrases("message template one foo", phrases), "FULL foo");
});

test("returns input unchanged when phrase list is empty", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(applyPhrases("hello", []), "hello");
});

test("matches at the start of the text", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("my email is here", [phrase("my email", "X")]),
    "X is here"
  );
});

test("preserves newlines in multi-line snippets", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("thanks sig", [phrase("sig", "Cheers,\nMatt")]),
    "thanks Cheers,\nMatt"
  );
});

test("escapes regex metacharacters in the trigger", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("see e.g. this", [phrase("e.g.", "for example")]),
    "see for example this"
  );
});

test("ignores phrases with blank triggers", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("hello world", [phrase("   ", "X"), phrase("", "Y")]),
    "hello world"
  );
});

test("substitutes every occurrence of a trigger", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(
    applyPhrases("my email and my email", [phrase("my email", "X")]),
    "X and X"
  );
});

test("returns input unchanged when text is empty", async () => {
  const { applyPhrases } = await import("../../src/utils/phraseSubstitution.js");
  assert.equal(applyPhrases("", [phrase("my email", "X")]), "");
});
