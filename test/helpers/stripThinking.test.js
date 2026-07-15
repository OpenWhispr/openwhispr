const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/stripThinking.js");

test("removes a well-formed think block and keeps the answer", async () => {
  const { stripThinkingTags } = await load();
  assert.equal(
    stripThinkingTags("<think>let me reason about this</think>Meeting Notes Summary"),
    "Meeting Notes Summary"
  );
});

test("removes an unterminated think block (streamed/cut off)", async () => {
  const { stripThinkingTags } = await load();
  assert.equal(stripThinkingTags("Title Here<think>reasoning that never closed"), "Title Here");
});

test("handles a title emitted before the think block", async () => {
  const { stripThinkingTags } = await load();
  assert.equal(stripThinkingTags("Quarterly Plan<think>...</think>"), "Quarterly Plan");
});

test("leaves plain text untouched", async () => {
  const { stripThinkingTags } = await load();
  assert.equal(stripThinkingTags("Project Kickoff Notes"), "Project Kickoff Notes");
});

test("a response that is only reasoning collapses to empty (title falls back)", async () => {
  const { stripThinkingTags } = await load();
  assert.equal(stripThinkingTags("<think>just thinking, no answer</think>"), "");
});

test("non-string input is returned as-is", async () => {
  const { stripThinkingTags } = await load();
  assert.equal(stripThinkingTags(undefined), undefined);
});
