const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkConversation } = require("../../src/helpers/conversationChunker");

test("returns empty array for empty or missing messages", () => {
  assert.deepEqual(chunkConversation("Title", []), []);
  assert.deepEqual(chunkConversation("Title", null), []);
  assert.deepEqual(chunkConversation("Title", undefined), []);
  assert.deepEqual(chunkConversation("Title", "not an array"), []);
});

test("filters out system messages and formats chunks", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there!" },
  ];

  const chunks = chunkConversation("General Chat", messages);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[0].text, "General Chat\nuser: Hello\nassistant: Hi there!");
});

test("splits large conversations with overlap", () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}` });
  }

  const chunks = chunkConversation("Long Chat", messages);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.equal(chunks[1].chunkIndex, 1);
});

test("handles nullish title and malformed message elements safely", () => {
  const messages = [
    null,
    { role: "user", content: "Valid message" },
    { content: "Missing role" },
    { role: "assistant" },
  ];

  const chunks = chunkConversation(null, messages);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "user: Valid message\nuser: Missing role\nassistant: ");
});
