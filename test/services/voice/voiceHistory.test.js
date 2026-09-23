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

test("an assistant turn that used tools replays its tool steps exactly", async () => {
  const { buildVoiceHistory } = await load();
  const steps = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "web_search", input: { query: "news" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "web_search", output: { type: "json", value: [] } }] },
    { role: "assistant", content: [{ type: "text", text: "Here is the news." }] },
  ];
  const history = buildVoiceHistory(
    [
      { id: "u1", role: "user", content: "news?" },
      { id: "a1", role: "assistant", content: "Here is the news." },
      { id: "u2", role: "user", content: "thanks" },
    ],
    new Map([["u1", "news?"]]),
    "",
    wrap,
    new Map([["a1", steps]])
  );
  assert.deepEqual(history, [{ role: "user", content: "news?" }, ...steps, { role: "user", content: "thanks" }]);
});

test("only the last 20 messages are sent, like typed chat", async () => {
  const { buildVoiceHistory } = await load();
  const messages = Array.from({ length: 25 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  }));
  const history = buildVoiceHistory(messages, new Map(), "", wrap);
  assert.equal(history.length, 20);
  assert.equal(history[0].content, "message 5");
});
