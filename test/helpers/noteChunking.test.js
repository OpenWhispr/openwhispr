const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../../src/helpers/llamaContextPolicy");

// Packs long material into parts that each fit the local model's window
// (#2142 part 3). The estimator is a deliberate copy of llamaContextPolicy's:
// the renderer cannot import that CommonJS module, so the last test pins the
// two together instead.

const load = () => import("../../src/helpers/noteChunking.js");

const normalise = (text) => text.replace(/\s+/g, " ").trim();

test("a body under budget is one chunk, untouched", async () => {
  const { planNoteChunks } = await load();
  const body = "Alice: hi\nBob: hello";
  assert.deepEqual(planNoteChunks(body, 1000), [body]);
});

test("chunks break only on line boundaries and lose no text", async () => {
  const { planNoteChunks, estimateNoteTokens } = await load();
  const lines = Array.from(
    { length: 200 },
    (_, i) => `Speaker ${i % 3}: line ${i} of the meeting about budgets.`
  );
  const body = lines.join("\n");
  const chunks = planNoteChunks(body, 120);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(estimateNoteTokens(chunk) <= 120, `chunk over budget: ${estimateNoteTokens(chunk)}`);
    for (const line of chunk.split("\n"))
      assert.ok(lines.includes(line), `split mid-line: ${line}`);
  }
  assert.equal(normalise(chunks.join("\n")), normalise(body));
});

test("a single line longer than the budget is split at spaces, never dropped", async () => {
  const { planNoteChunks, estimateNoteTokens } = await load();
  const body = "Them: " + "word ".repeat(600).trim();
  const chunks = planNoteChunks(body, 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(estimateNoteTokens(chunk) <= 50);
  assert.equal(normalise(chunks.join(" ")), normalise(body));
});

test("an unbroken run (CJK, no spaces) longer than the budget is sliced by tokens", async () => {
  const { planNoteChunks, estimateNoteTokens } = await load();
  const body = "会議".repeat(300);
  const chunks = planNoteChunks(body, 100);
  assert.ok(chunks.length >= 6);
  for (const chunk of chunks) assert.ok(estimateNoteTokens(chunk) <= 100);
  assert.equal(chunks.join(""), body);
});

test("empty and whitespace-only bodies plan to no chunks", async () => {
  const { planNoteChunks } = await load();
  assert.deepEqual(planNoteChunks("", 100), []);
  assert.deepEqual(planNoteChunks("\n  \n", 100), []);
});

test("transcript continuations retain their speaker within the token budget", async () => {
  const { planNoteChunks, estimateNoteTokens } = await load();
  const body = "Bob: " + "We discussed the rollout. ".repeat(100) + "I own the invoice.";
  const chunks = planNoteChunks(body, 100, { preserveSpeakerLabels: true });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith("Bob: "));
    assert.ok(estimateNoteTokens(chunk) <= 100);
  }
  assert.equal(
    normalise(chunks.map((chunk) => chunk.replace(/^Bob: /, "")).join(" ")),
    normalise(body.slice(5))
  );
});

test("plain notes do not repeat colon-prefixed text as a speaker", async () => {
  const { planNoteChunks } = await load();
  const chunks = planNoteChunks("Agenda: " + "topic ".repeat(100), 100);
  assert.equal(chunks.filter((chunk) => chunk.includes("Agenda:")).length, 1);
});

test("a raw transcript's oversized colon prefix does not defeat chunking or retries", async () => {
  const { planNoteChunks, splitChunkInHalf, estimateNoteTokens } = await load();
  const body = "Background ".repeat(1000) + ": " + "Follow up ".repeat(20);
  const options = { preserveSpeakerLabels: true };
  const chunks = planNoteChunks(body, 1800, options);
  for (const chunk of chunks) assert.ok(estimateNoteTokens(chunk) <= 1800);
  assert.equal(normalise(chunks.join(" ")), normalise(body));
  for (const half of splitChunkInHalf(body, options)) {
    assert.ok(estimateNoteTokens(half) < estimateNoteTokens(body) * 0.75);
  }
});

test("halving a skewed chunk splits the dominant line instead of only its neighbours", async () => {
  const { splitChunkInHalf } = await load();
  const body = "🚀".repeat(3500) + "\n" + "short\n".repeat(16).trim();
  const halves = splitChunkInHalf(body);
  assert.equal(
    halves.map((half) => (half.match(/🚀/gu) || []).length).reduce((sum, count) => sum + count),
    3500
  );
  for (const half of halves) {
    assert.ok((half.match(/🚀/gu) || []).length < 2500);
    assert.ok(half.isWellFormed());
  }
});

test("retry splits preserve the speaker of a divided turn", async () => {
  const { splitChunkInHalf } = await load();
  const body = "Bob: " + "word ".repeat(100) + "I own the invoice.";
  const halves = splitChunkInHalf(body, { preserveSpeakerLabels: true });
  assert.ok(halves.every((half) => half.startsWith("Bob: ")));
  assert.equal(normalise(halves.map((half) => half.slice(5)).join(" ")), normalise(body.slice(5)));
});

test("splitChunkInHalf prefers line boundaries, then word boundaries", async () => {
  const { splitChunkInHalf } = await load();
  assert.deepEqual(splitChunkInHalf("a\nb\nc\nd"), ["a\nb", "c\nd"]);
  assert.deepEqual(splitChunkInHalf("one two three four"), ["one two", "three four"]);
});

test("splitChunkInHalf splits unbroken runs without losing Unicode code points", async () => {
  const { splitChunkInHalf } = await load();
  for (const text of ["会議".repeat(300), "𠀀𠀁𠀂", "会🚀議", "single"]) {
    const halves = splitChunkInHalf(text);
    assert.ok(halves, `could not split ${text.slice(0, 20)}`);
    assert.equal(halves.join(""), text);
    assert.deepEqual(
      halves.map((half) => Array.from(half).length),
      [Math.ceil(Array.from(text).length / 2), Math.floor(Array.from(text).length / 2)]
    );
    for (const half of halves) assert.ok(half.isWellFormed());
  }
});

test("splitChunkInHalf gives up only on empty or single-code-point chunks", async () => {
  const { splitChunkInHalf } = await load();
  for (const text of ["", "a", "会", "𠀀", "🚀", " ", "\n"]) {
    assert.equal(splitChunkInHalf(text), null);
  }
});

test("the estimate agrees with llamaContextPolicy on Latin, CJK and mixed text", async () => {
  const { estimateNoteTokens } = await load();
  const fixtures = [
    "",
    "Alice: we agreed to ship on Friday.",
    "会議は金曜日に決まりました。",
    "Mixed 会議 text with ünïcödé and emoji 🚀.",
    "x".repeat(10000),
  ];
  for (const text of fixtures) {
    assert.equal(
      estimateNoteTokens(text),
      policy.estimateTokens(text),
      JSON.stringify(text.slice(0, 20))
    );
  }
});
