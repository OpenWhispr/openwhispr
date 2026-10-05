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
  assert.equal(filter.finish(), "");
});

test("a stray close tag with no open block is dropped, keeping the text (#1861)", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filter("plain</think>text"), "plaintext");
});

test("a stray close tag split across chunks is dropped", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filterAll(filter, ["plain</th", "ink>text"]), "plaintext");
});

test("strips mixed-case and uppercase think blocks (#1861)", async () => {
  const { createStreamingThinkFilter } = await load();
  assert.equal(createStreamingThinkFilter()("<Think>reasoning</Think>Answer"), "Answer");
  assert.equal(createStreamingThinkFilter()("<THINK>reasoning</THINK>Answer"), "Answer");
  assert.equal(createStreamingThinkFilter()("plain</Think>text"), "plaintext");
});

test("an uppercase unterminated block suppresses everything after it", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(filterAll(filter, ["Answer<THINK>never", " closes"]), "Answer");
  assert.equal(filter.finish(), "");
});

test("resumes normal output after a closed nested block", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();
  assert.equal(
    filterAll(filter, ["<think>a<think>b</think>", "c</think>First", " second"]),
    "First second"
  );
});

test("strips nested think blocks at every two-chunk boundary", async () => {
  const { createStreamingThinkFilter } = await load();
  const input = "<think>a<think>b</think>c</think>Answer";

  for (let split = 1; split < input.length; split += 1) {
    const filter = createStreamingThinkFilter();
    assert.equal(
      filterAll(filter, [input.slice(0, split), input.slice(split)]),
      "Answer",
      `split at character ${split}`
    );
  }
});

test("strips mixed-case nested think blocks at every two-chunk boundary", async () => {
  const { createStreamingThinkFilter } = await load();
  const input = "<Think>a<THINK>b</think>c</THINK>Answer";

  for (let split = 1; split < input.length; split += 1) {
    const filter = createStreamingThinkFilter();
    assert.equal(
      filterAll(filter, [input.slice(0, split), input.slice(split)]),
      "Answer",
      `split at character ${split}`
    );
  }
});

test("buffers a possible opening tag and flushes it when the stream ends", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();

  assert.equal(filter("Answer<thi"), "Answer");
  assert.equal(filter.finish(), "<thi");
});

test("buffers a possible close tag and flushes it when the stream ends", async () => {
  const { createStreamingThinkFilter } = await load();
  const filter = createStreamingThinkFilter();

  assert.equal(filter("text</thi"), "text");
  assert.equal(filter.finish(), "</thi");
});
