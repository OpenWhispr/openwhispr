const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../../src/services/voice/voiceHistory.ts");

const wrap = (text, context) => `[${context}] ${text}`;

test("the newest user turn is sent with its context, and that exact text is remembered", async () => {
  const { buildVoiceHistory } = await load();
  const sent = new Map();
  const history = buildVoiceHistory(
    [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
      { id: "u2", role: "user", content: "weather?" },
    ],
    sent,
    "ctx-2",
    wrap
  );
  assert.deepEqual(history.at(-1), { role: "user", content: "[ctx-2] weather?" });
  assert.equal(sent.get("u2"), "[ctx-2] weather?");
});

test("earlier turns replay exactly what was sent, so the prompt prefix never changes", async () => {
  const { buildVoiceHistory } = await load();
  const sent = new Map([["u1", "[ctx-1] hi"]]);
  const history = buildVoiceHistory(
    [
      { id: "u1", role: "user", content: "hi" },
      { id: "a1", role: "assistant", content: "hello" },
      { id: "u2", role: "user", content: "weather?" },
    ],
    sent,
    "ctx-2",
    wrap
  );
  assert.deepEqual(history, [
    { role: "user", content: "[ctx-1] hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "[ctx-2] weather?" },
  ]);
});

test("without per-turn context the newest user turn is sent and remembered as-is", async () => {
  const { buildVoiceHistory } = await load();
  const sent = new Map();
  const history = buildVoiceHistory([{ id: "u1", role: "user", content: "hi" }], sent, "", wrap);
  assert.deepEqual(history, [{ role: "user", content: "hi" }]);
  assert.equal(sent.get("u1"), "hi");
});

test("an already-sent newest turn (a retry) keeps its original context", async () => {
  const { buildVoiceHistory } = await load();
  const sent = new Map([["u1", "[ctx-old] hi"]]);
  const history = buildVoiceHistory([{ id: "u1", role: "user", content: "hi" }], sent, "ctx-new", wrap);
  assert.deepEqual(history, [{ role: "user", content: "[ctx-old] hi" }]);
});

const conversation = (length) =>
  Array.from({ length }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  }));

test("short conversations are sent whole", async () => {
  const { buildVoiceHistory } = await load();
  assert.equal(buildVoiceHistory(conversation(19), new Map(), "", wrap).length, 19);
  assert.equal(buildVoiceHistory(conversation(20), new Map(), "", wrap).length, 20);
});

// Dropping one message per turn changes the start of the prompt every turn and
// forces a full re-read (6-11 s at ~8k tokens); dropping in blocks of 10 keeps
// the prefix stable for ~5 turns at a time.
test("old messages are dropped in blocks, so the window start rarely moves", async () => {
  const { buildVoiceHistory } = await load();
  const starts = [21, 22, 25, 29, 30, 31].map(
    (length) => buildVoiceHistory(conversation(length), new Map(), "", wrap)[0].content
  );
  assert.deepEqual(starts, [
    "message 10",
    "message 10",
    "message 10",
    "message 10",
    "message 10",
    "message 20",
  ]);
});

test("the window never starts on an assistant message", async () => {
  const { buildVoiceHistory } = await load();
  const messages = conversation(24);
  messages.splice(1, 1); // odd gap shifts every later role by one index
  const history = buildVoiceHistory(messages, new Map(), "", wrap);
  assert.equal(history[0].role, "user");
});
