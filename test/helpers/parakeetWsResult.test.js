const test = require("node:test");
const assert = require("node:assert/strict");

const { parseOfflineMessage, parseOnlineMessages } = require("../../src/helpers/parakeetWsResult");

test("offline sherpa message extracts JSON text", () => {
  assert.equal(parseOfflineMessage(JSON.stringify({ text: "hello world" })), "hello world");
  assert.equal(parseOfflineMessage("2026"), "2026");
});

test("online sherpa messages keep finalized segments and latest partial", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "hello", is_final: false, segment: 0 }),
      JSON.stringify({ text: "hello world", is_final: true, segment: 0 }),
      JSON.stringify({ text: "again", is_final: false, segment: 1 }),
    ]),
    "hello world again"
  );
});

test("online sherpa duplicate final keeps a newer segment partial", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "hello", is_final: true, segment: 0 }),
      JSON.stringify({ text: "new partial", is_final: false, segment: 1 }),
      JSON.stringify({ text: "hello", is_final: true, segment: 0 }),
    ]),
    "hello new partial"
  );
});

test("online sherpa matching final replaces its partial", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "hello", is_final: false, segment: 0 }),
      JSON.stringify({ text: "hello world", is_final: true, segment: 0 }),
    ]),
    "hello world"
  );
});

test("online sherpa parser keeps numeric final text as text", () => {
  assert.equal(
    parseOnlineMessages([JSON.stringify({ text: "2026", is_final: true, segment: 0 })]),
    "2026"
  );
});

test("online sherpa parser ignores JSON scalar control messages", () => {
  assert.equal(
    parseOnlineMessages([
      "null",
      "true",
      JSON.stringify({ text: "hello", is_final: true, segment: 0 }),
    ]),
    "hello"
  );
});

test("online sherpa parser keeps latest partial before ignored trailing messages", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "hello", is_final: false, segment: 0 }),
      "null",
      JSON.stringify({ text: "", is_final: false, segment: 0 }),
    ]),
    "hello"
  );
});

test("online sherpa parser tolerates non-string text payloads", () => {
  assert.equal(
    parseOnlineMessages([JSON.stringify({ text: 2026, is_final: true, segment: 0 })]),
    "2026"
  );
});

test("online sherpa parser keeps the latest text when a segment is refined", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "the quick", is_final: true, segment: 0 }),
      JSON.stringify({ text: "brown", is_final: true, segment: 1 }),
      JSON.stringify({ text: "the quick fox", is_final: true, segment: 0 }),
    ]),
    "the quick fox brown"
  );
});

test("online sherpa parser treats an identical duplicate final as a no-op", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "hello", is_final: true, segment: 0 }),
      JSON.stringify({ text: "world", is_final: true, segment: 1 }),
      JSON.stringify({ text: "hello", is_final: true, segment: 0 }),
    ]),
    "hello world"
  );
});

test("online sherpa parser suppresses a partial for an already-finalized segment", () => {
  assert.equal(
    parseOnlineMessages([
      JSON.stringify({ text: "done", is_final: true, segment: 0 }),
      JSON.stringify({ text: "late partial", is_final: false, segment: 0 }),
    ]),
    "done"
  );
});
