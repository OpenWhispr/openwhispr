const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkConversation } = require("../../src/helpers/conversationChunker");

const msg = (i, role = "user") => ({ role, content: `m${i}` });
const msgs = (n) => Array.from({ length: n }, (_, i) => msg(i));
const windowOf = (chunk) => chunk.text.split("\n").slice(1);

test("chunks a short conversation into a single chunk with title header", () => {
  const chunks = chunkConversation("Trip planning", [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.deepEqual(chunks, [
    { chunkIndex: 0, text: "Trip planning\nuser: hello\nassistant: hi there" },
  ]);
});

test("excludes system messages from chunk windows", () => {
  const chunks = chunkConversation("t", [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(chunks, [{ chunkIndex: 0, text: "t\nuser: hello" }]);
});

test("returns empty array for a conversation with only system messages", () => {
  assert.deepEqual(chunkConversation("t", [{ role: "system", content: "s" }]), []);
});

test("splits nine messages into three overlapping windows with sequential chunk indexes", () => {
  const chunks = chunkConversation("t", msgs(9));
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    [0, 1, 2]
  );
  assert.deepEqual(windowOf(chunks[0]), [
    "user: m0",
    "user: m1",
    "user: m2",
    "user: m3",
    "user: m4",
  ]);
  assert.deepEqual(windowOf(chunks[1]), [
    "user: m3",
    "user: m4",
    "user: m5",
    "user: m6",
    "user: m7",
  ]);
  assert.deepEqual(windowOf(chunks[2]), ["user: m6", "user: m7", "user: m8"]);
});

test("keeps a trailing window that carries messages not covered by the previous chunk", () => {
  const chunks = chunkConversation("t", msgs(12));
  assert.equal(chunks.length, 4);
  assert.deepEqual(windowOf(chunks[3]), ["user: m9", "user: m10", "user: m11"]);
});

test("truncates chunk text at 1500 characters", () => {
  const chunks = chunkConversation("t", [{ role: "user", content: "x".repeat(2000) }]);
  assert.equal(chunks[0].text.length, 1500);
  assert.ok(chunks[0].text.startsWith("t\nuser: xxx"));
});

test("returns empty array for null, undefined, and non-array messages input", () => {
  assert.deepEqual(chunkConversation("t", null), []);
  assert.deepEqual(chunkConversation("t", undefined), []);
  assert.deepEqual(chunkConversation("t", "not an array"), []);
  assert.deepEqual(chunkConversation("t", { role: "user", content: "hi" }), []);
  assert.deepEqual(chunkConversation("t", 42), []);
});

test("skips null and undefined message entries instead of throwing", () => {
  const chunks = chunkConversation("t", [null, { role: "user", content: "hi" }, undefined]);
  assert.deepEqual(chunks, [{ chunkIndex: 0, text: "t\nuser: hi" }]);
});

test("skips message entries with missing or non-string role or content", () => {
  const chunks = chunkConversation("t", [
    { content: "no role" },
    { role: "user" },
    { role: "user", content: 42 },
    { role: 7, content: "numeric role" },
    { role: "user", content: null },
    "not an object",
    { role: "user", content: "kept" },
  ]);
  assert.deepEqual(chunks, [{ chunkIndex: 0, text: "t\nuser: kept" }]);
});

test("returns empty array when every message entry is malformed", () => {
  assert.deepEqual(chunkConversation("t", [null, { role: "user" }, "junk"]), []);
});

test("normalizes null, undefined, and non-string titles to an empty header", () => {
  const messages = [{ role: "user", content: "hi" }];
  assert.equal(chunkConversation(null, messages)[0].text, "\nuser: hi");
  assert.equal(chunkConversation(undefined, messages)[0].text, "\nuser: hi");
  assert.equal(chunkConversation(7, messages)[0].text, "\nuser: hi");
});

test("trims surrounding whitespace from the title header", () => {
  const chunks = chunkConversation("  Trip planning  ", [{ role: "user", content: "hi" }]);
  assert.equal(chunks[0].text, "Trip planning\nuser: hi");
});

test("omits a trailing sub-window already covered by the previous chunk", () => {
  const chunks = chunkConversation("t", msgs(8));
  assert.equal(chunks.length, 2);
  assert.deepEqual(windowOf(chunks[0]), [
    "user: m0",
    "user: m1",
    "user: m2",
    "user: m3",
    "user: m4",
  ]);
  assert.deepEqual(windowOf(chunks[1]), [
    "user: m3",
    "user: m4",
    "user: m5",
    "user: m6",
    "user: m7",
  ]);
});

test("omits the covered trailing sub-window when the last full window ends exactly on the final message", () => {
  const chunks = chunkConversation("t", msgs(11));
  assert.equal(chunks.length, 3);
  assert.deepEqual(windowOf(chunks[2]), [
    "user: m6",
    "user: m7",
    "user: m8",
    "user: m9",
    "user: m10",
  ]);
});
