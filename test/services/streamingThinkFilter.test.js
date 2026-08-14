const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/ai/streamingThinkFilter.ts");

const filterAll = (filter, chunks) => chunks.map((chunk) => filter(chunk)).join("");

test("plain text passes through unchanged", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("Hello world"), "Hello world");
});

test("strips a complete think block within one chunk", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("<think>reasoning</think>Answer"), "Answer");
});

test("strips a nested think block within one chunk (#1617 streaming twin)", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("<think>a<think>b</think>c</think>Answer"), "Answer");
});

test("strips a nested think block split across chunks", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filterAll(filter, ["<think>a<think>b", "</think>c</think>Answer"]), "Answer");
});

test("strips multiple sibling think blocks within one chunk", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("<think>a</think>X<think>b</think>Y"), "XY");
});

test("suppresses chunks that are entirely inside a block", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("<think>start"), "");
  assert.equal(filter("still reasoning"), "");
  assert.equal(filter("done</think>The answer"), "The answer");
});

test("preserves text before the opening tag", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("Intro<think>hidden</think> outro"), "Intro outro");
});

test("an unterminated block suppresses everything after it", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filterAll(filter, ["Answer<think>never", " closes"]), "Answer");
});

test("a stray close tag with no open block passes through", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("plain</think>text"), "plain</think>text");
});

test("resumes normal output after a closed nested block", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(
    filterAll(filter, ["<think>a<think>b</think>", "c</think>First", " second"]),
    "First second"
  );
});
