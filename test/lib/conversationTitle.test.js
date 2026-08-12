const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveConversationTitle } = require("../../src/lib/conversationTitle.ts");

test("short messages become the title verbatim", () => {
  assert.equal(deriveConversationTitle("Catch me up", "Growth"), "Catch me up");
});

test("long messages truncate to 40 chars with an ellipsis", () => {
  const text = "What were the key decisions from the sales sync last Thursday?";
  const title = deriveConversationTitle(text, "Growth");
  assert.equal(title.endsWith("…"), true);
  assert.equal(title.length <= 41, true);
  assert.equal(title, "What were the key decisions from the sal…");
});

test("whitespace-only input falls back to the container name", () => {
  assert.equal(deriveConversationTitle("   \n\t ", "Growth"), "Growth");
  assert.equal(deriveConversationTitle("", "Growth"), "Growth");
});

test("internal newlines and runs of spaces collapse to single spaces", () => {
  assert.equal(deriveConversationTitle("catch\nme   up\t please", "Growth"), "catch me up please");
});

test("a message landing exactly on the limit is not truncated", () => {
  const text = "x".repeat(40);
  assert.equal(deriveConversationTitle(text, "Growth"), text);
});
