const test = require("node:test");
const assert = require("node:assert");

const {
  chunkSegments,
  chunkText,
  resolveChunkBudget,
  estimateTokens,
} = require("../../src/helpers/transcriptPassChunker");
const { estimatePromptTokens, PROMPT_SHARE } = require("../../src/helpers/llamaContext");

const seg = (label, text) => ({ label, text });
const within = (chunks, budget) => chunks.every((c) => estimateTokens(c) <= budget);

test("estimateTokens agrees with the pre-flight guard's estimator", () => {
  // If these two ever disagree, the chunker will happily build chunks that
  // modelManagerBridge then rejects.
  const text = "x".repeat(1234);
  assert.equal(estimateTokens(text), estimatePromptTokens(text));
});

test("estimateTokens never under-estimates ASCII", () => {
  const text = "a".repeat(360);
  assert.ok(estimateTokens(text) >= 100);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
});

test("resolveChunkBudget derives from the context using the guard's own share", () => {
  const { inputBudget, chunkBudget } = resolveChunkBudget({ contextSize: 32768 });
  assert.equal(inputBudget, Math.floor(32768 * PROMPT_SHARE));
  assert.equal(inputBudget, 19660);
  assert.equal(chunkBudget, Math.floor(19660 * 0.75));
  assert.ok(chunkBudget < inputBudget);
});

test("resolveChunkBudget shrinks the chunk on a CPU backend", () => {
  const gpu = resolveChunkBudget({ contextSize: 32768, isGpuBackend: true });
  const cpu = resolveChunkBudget({ contextSize: 32768, isGpuBackend: false });
  // A ~15k-token prefill on CPU would blow llama-server's request timeout.
  assert.ok(cpu.chunkBudget < gpu.chunkBudget / 2);
  assert.equal(cpu.inputBudget, gpu.inputBudget, "the compose budget is unchanged");
});

test("returns one chunk when everything fits", () => {
  const segments = [seg("You", "hello there"), seg("Them", "hi back")];
  const chunks = chunkSegments(segments, 1000);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /You: hello there/);
  assert.match(chunks[0], /Them: hi back/);
});

test("packs whole segments and never splits one that fits", () => {
  const segments = Array.from({ length: 20 }, (_, i) => seg("You", "w".repeat(360) + `#${i}`));
  const budget = 400; // ~4 segments per chunk
  const chunks = chunkSegments(segments, budget, { overlapSegments: 0 });

  assert.ok(chunks.length > 1);
  assert.ok(within(chunks, budget), "no chunk may exceed the budget");
  for (let i = 0; i < 20; i++) {
    assert.ok(chunks.some((c) => c.includes(`#${i}`)), `segment #${i} must survive`);
  }
});

test("overlap carries exactly the last segment of the previous chunk", () => {
  const segments = Array.from({ length: 12 }, (_, i) => seg("You", "w".repeat(360) + `#${i}`));
  const budget = 400;
  const chunks = chunkSegments(segments, budget, { overlapSegments: 1 });

  assert.ok(chunks.length > 1);
  assert.ok(within(chunks, budget), "overlap must not push a chunk over budget");
  for (let i = 1; i < chunks.length; i++) {
    const prevLast = chunks[i - 1].trim().split("\n").pop();
    assert.equal(chunks[i].split("\n")[0], prevLast, "chunk must open with the previous tail");
  }
});

test("a single segment larger than the budget is split rather than emitted over budget", () => {
  // One uninterrupted 20-minute monologue. Emitting it whole would fail the
  // pre-flight guard and lose that whole stretch of the call.
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the thing.`).join(
    " "
  );
  const chunks = chunkSegments([seg("Them", long)], 60, { overlapSegments: 0 });

  assert.ok(chunks.length > 1);
  assert.ok(within(chunks, 60));
  assert.match(chunks.join(" "), /Sentence number 0 /);
  assert.match(chunks.join(" "), /Sentence number 39 /);
});

test("splits a budget-busting segment with no sentence punctuation at all", () => {
  const blob = "word ".repeat(500).trim();
  const chunks = chunkSegments([seg("You", blob)], 50, { overlapSegments: 0 });
  assert.ok(chunks.length > 1);
  assert.ok(within(chunks, 50));
});

test("a single token longer than the budget still terminates", () => {
  const chunks = chunkSegments([seg("You", "z".repeat(5000))], 20, { overlapSegments: 0 });
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.join("").includes("z"));
});

test("handles empty and degenerate input", () => {
  assert.deepEqual(chunkSegments([], 100), []);
  assert.deepEqual(chunkSegments(null, 100), []);
  assert.equal(chunkSegments([seg("You", "hi")], 100).length, 1);
  assert.deepEqual(chunkSegments([seg("You", "  ")], 100), []);
});

test("an unlabelled segment is emitted without a colon prefix", () => {
  const chunks = chunkSegments([seg("", "bare line")], 100);
  assert.equal(chunks[0], "bare line");
});

test("chunkText packs on paragraph boundaries", () => {
  const paras = Array.from({ length: 10 }, (_, i) => "p".repeat(360) + `#${i}`);
  const chunks = chunkText(paras.join("\n\n"), 400);

  assert.ok(chunks.length > 1);
  assert.ok(within(chunks, 400));
  for (let i = 0; i < 10; i++) {
    assert.ok(chunks.some((c) => c.includes(`#${i}`)));
  }
});

test("chunkText returns one chunk when the whole text fits", () => {
  assert.deepEqual(chunkText("short note", 1000), ["short note"]);
  assert.deepEqual(chunkText("", 1000), []);
});

test("chunkText splits an oversized single paragraph", () => {
  const chunks = chunkText("word ".repeat(500).trim(), 50);
  assert.ok(chunks.length > 1);
  assert.ok(within(chunks, 50));
});
