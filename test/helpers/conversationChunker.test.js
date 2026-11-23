const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkConversation } = require("../../src/helpers/conversationChunker");

// The MiniLM embedder reads at most 256 tokens, roughly the first 1,000
// characters of a chunk, so a message only counts as indexed if it starts there.
const EMBEDDED_PREFIX_CHARS = 1000;

const longReply = (lead) => `${lead}. ${"More detail about the plan. ".repeat(60)}`;

const isIndexed = (chunks, message) =>
  chunks.some((chunk) =>
    chunk.text
      .slice(0, EMBEDDED_PREFIX_CHARS)
      .includes(`${message.role}: ${message.content.slice(0, 30)}`)
  );

test("every message of a chat with long replies starts inside an embedded chunk", () => {
  const messages = [
    { role: "user", content: "How do I plan Project Falcon?" },
    { role: "assistant", content: longReply("Here is a plan") },
    { role: "user", content: "Also remind me what the quarterly budget for Project Falcon was" },
    { role: "assistant", content: longReply("The budget was set in March") },
    { role: "user", content: "Thanks" },
    { role: "assistant", content: longReply("You're welcome") },
  ];
  const chunks = chunkConversation("Falcon planning", messages);
  for (const [i, message] of messages.entries()) {
    assert.ok(isIndexed(chunks, message), `message ${i} (${message.role}) is not indexed`);
  }
});

test("short chats keep their full text", () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ];
  assert.deepEqual(chunkConversation("Greeting", messages), [
    { chunkIndex: 0, text: "Greeting\nuser: hello\nassistant: hi there" },
  ]);
});
