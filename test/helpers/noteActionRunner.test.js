const test = require("node:test");
const assert = require("node:assert");

const { runNoteAction, GAP_MARKER } = require("../../src/helpers/noteActionRunner");

const coded = (message, code) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

const seg = (label, text) => ({ label, text });

// Enough segments to force several chunks at the budget used below.
const manySegments = (n, size = 400) =>
  Array.from({ length: n }, (_, i) => seg("You", "w".repeat(size) + ` #${i}`));

function harness(overrides = {}) {
  const calls = [];
  const progress = [];
  const base = {
    contextSize: overrides.contextSize ?? 4096,
    isGpuBackend: true,
    systemPrompt: "SYS",
    noteContent: "",
    segments: [],
    sleep: async () => {},
    onProgress: (p) => progress.push({ ...p }),
    infer: async (prompt, opts) => {
      calls.push({ prompt, opts });
      return `out(${calls.length})`;
    },
  };
  return { calls, progress, options: { ...base, ...overrides } };
}

test("a prompt that fits produces exactly one inference call", async () => {
  const h = harness({ noteContent: "short note", segments: [seg("You", "hello")] });
  const result = await runNoteAction(h.options);

  assert.equal(h.calls.length, 1, "single-pass must stay a single call");
  assert.equal(result.passes, 1);
  assert.equal(result.partial, false);
  assert.equal(result.text, "out(1)");
  assert.match(h.calls[0].prompt, /short note/);
  assert.match(h.calls[0].prompt, /You: hello/);
  assert.equal(h.calls[0].opts.systemPrompt, "SYS", "the user's action prompt is used verbatim");
});

test("an over-budget transcript produces N extraction calls plus one compose", async () => {
  const segments = manySegments(24);
  const h = harness({ segments });
  const result = await runNoteAction(h.options);

  assert.ok(h.calls.length > 2, "must have split into multiple passes");
  const composes = h.calls.filter((c) => c.opts.systemPrompt === "SYS");
  assert.equal(composes.length, 1, "the user's action prompt runs exactly once");
  assert.equal(composes[composes.length - 1], h.calls[h.calls.length - 1], "compose runs last");

  const extractions = h.calls.slice(0, -1);
  assert.ok(extractions.every((c) => c.opts.maxTokens === 800));
  assert.ok(extractions.every((c) => c.opts.temperature === 0.1));
  assert.equal(result.passes, h.calls.length);
  assert.equal(result.partial, false);
});

test("every source segment reaches some extraction pass", async () => {
  const segments = manySegments(24);
  const h = harness({ segments });
  await runNoteAction(h.options);

  const extracted = h.calls.slice(0, -1).map((c) => c.prompt).join("\n");
  for (let i = 0; i < 24; i++) {
    assert.ok(extracted.includes(`#${i}`), `segment #${i} must not be dropped`);
  }
});

test("progress reports extracting then composing with a stable total", async () => {
  const h = harness({ segments: manySegments(24) });
  await runNoteAction(h.options);

  assert.ok(h.progress.length > 1);
  const totals = new Set(h.progress.map((p) => p.totalPasses));
  assert.equal(totals.size, 1, "totalPasses must not change mid-run");
  assert.equal(h.progress[0].phase, "extracting");
  assert.equal(h.progress[h.progress.length - 1].phase, "composing");
  assert.deepEqual(
    h.progress.map((p) => p.currentPass),
    h.progress.map((_, i) => i + 1)
  );
});

test("a transient failure is retried and leaves no gap marker", async () => {
  let n = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      n++;
      if (n === 2) throw coded("busy", "LOCAL_INFERENCE_BUSY");
      return `out(${n})`;
    },
  });

  const result = await runNoteAction(h.options);
  assert.equal(result.partial, false);
  assert.ok(!result.text.includes(GAP_MARKER));
});

test("a startup SIGKILL is retried, not written into the notes", async () => {
  let n = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      n++;
      if (n === 2) throw coded("died during startup (signal: SIGKILL)", "LLAMA_START_FAILED");
      return `out(${n})`;
    },
  });

  const result = await runNoteAction(h.options);
  assert.equal(result.partial, false, "a machine problem must never become a gap marker");
});

test("transient retries exhausted is fatal, not a gap marker", async () => {
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      throw coded("timed out", "LLAMA_REQUEST_TIMEOUT");
    },
  });

  await assert.rejects(() => runNoteAction(h.options), (err) => {
    assert.ok(!String(err.message).includes(GAP_MARKER));
    return err.code === "LOCAL_MULTIPASS_FAILED";
  });
});

test("a genuine failure twice yields a gap marker and the run still completes", async () => {
  let n = 0;
  const h = harness({ segments: manySegments(24) });
  h.options.infer = async (prompt, opts) => {
    n++;
    // Fail the first extraction on both its attempts.
    if (opts.systemPrompt !== "SYS" && n <= 2) throw coded("empty", "EMPTY_RESPONSE");
    h.calls.push({ prompt, opts });
    return `out(${n})`;
  };

  const result = await runNoteAction(h.options);
  assert.equal(result.partial, true);
  assert.ok(result.gapCount >= 1);
  const compose = h.calls[h.calls.length - 1];
  assert.ok(compose.prompt.includes(GAP_MARKER));
});

test("three consecutive genuine failures abort the job", async () => {
  const h = harness({
    segments: manySegments(60),
    infer: async (_prompt, opts) => {
      if (opts.systemPrompt !== "SYS") throw coded("empty", "EMPTY_RESPONSE");
      return "composed";
    },
  });

  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_MULTIPASS_FAILED"
  );
});

test("a fatal error aborts immediately without retrying", async () => {
  let n = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      n++;
      throw coded("gone", "MODEL_NOT_DOWNLOADED");
    },
  });

  await assert.rejects(() => runNoteAction(h.options), (err) => err.code === "MODEL_NOT_DOWNLOADED");
  assert.equal(n, 1, "a fatal error must not be retried");
});

test("cancellation between passes stops further passes", async () => {
  const controller = new AbortController();
  let n = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      n++;
      if (n === 2) controller.abort();
      return `out(${n})`;
    },
  });
  h.options.signal = controller.signal;

  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_INFERENCE_ABORTED"
  );
  assert.equal(n, 2, "no pass may start after cancellation");
});

test("resumes from provided extracts and skips completed chunks", async () => {
  const segments = manySegments(24);
  const first = harness({ segments });
  const full = await runNoteAction(first.options);
  const chunkCount = first.calls.length - 1;

  const resumed = harness({ segments });
  resumed.options.resumeExtracts = Array.from({ length: chunkCount - 1 }, (_, i) => `saved-${i}`);
  const result = await runNoteAction(resumed.options);

  assert.equal(resumed.calls.length, 2, "one remaining extraction plus compose");
  assert.match(resumed.calls[1].prompt, /saved-0/);
  assert.ok(full.text && result.text);
});

test("reports completed extracts so a caller can persist progress", async () => {
  const saved = [];
  const h = harness({ segments: manySegments(24) });
  h.options.onExtract = (index, text) => saved.push({ index, text });

  await runNoteAction(h.options);
  assert.ok(saved.length >= 2);
  assert.deepEqual(
    saved.map((s) => s.index),
    saved.map((_, i) => i)
  );
});

test("compose overflow folds the extracts rather than sending an over-budget compose", async () => {
  // Extractions return far more than the 800-token cap would allow, so the
  // concatenated extracts cannot fit the compose budget without folding.
  const big = "e".repeat(6000);
  let composed = null;
  const h = harness({
    segments: manySegments(40),
    infer: async (prompt, opts) => {
      if (opts.systemPrompt === "SYS") {
        composed = prompt;
        return "final";
      }
      return big;
    },
  });

  const result = await runNoteAction(h.options);
  assert.equal(result.text, "final");
  assert.ok(result.foldLevels >= 1, "must have folded at least once");
  const { estimateTokens } = require("../../src/helpers/transcriptPassChunker");
  assert.ok(
    estimateTokens(composed) <= result.inputBudget,
    "the compose prompt must fit the input budget"
  );
});

test("compose still over budget after the fold cap fails with a typed error", async () => {
  const huge = "e".repeat(200000);
  const h = harness({
    segments: manySegments(40),
    infer: async (_prompt, opts) => (opts.systemPrompt === "SYS" ? "final" : huge),
  });

  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_CONTEXT_EXCEEDED"
  );
});

test("manual note content alone larger than the compose budget fails rather than looping", async () => {
  // Folding shrinks extracts; it can never shrink the note content that is
  // carried into the compose step alongside them.
  const h = harness({ noteContent: "n".repeat(200000), segments: manySegments(24) });
  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_CONTEXT_EXCEEDED"
  );
});

test("a non-meeting note with no segments still chunks its own text", async () => {
  const h = harness({ noteContent: "para\n\n".repeat(4000), segments: [] });
  const result = await runNoteAction(h.options);
  assert.ok(result.passes > 2, "long manual notes must be split, not rejected");
  assert.equal(result.partial, false);
});

// ── 1.16.1: fail fast instead of grinding toward a provable failure ─────────

test("a run that provably cannot compose fails before any inference", async () => {
  // At a small context the chunk budget collapses, so a long transcript needs
  // more extracts than the compose step can ever hold — even after the fold cap.
  // Discovering that after 150 passes and three hours is strictly worse than
  // discovering it in a millisecond.
  const h = harness({ contextSize: 2048, segments: manySegments(400) });
  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_CONTEXT_EXCEEDED"
  );
  assert.equal(h.calls.length, 0, "must not run a single pass it cannot finish");
});

test("a viable run at a small context still proceeds", async () => {
  const h = harness({ contextSize: 2048, segments: manySegments(4, 200) });
  const result = await runNoteAction(h.options);
  assert.ok(result.text);
  assert.ok(h.calls.length >= 1);
});

test("the fail-fast check does not fire on the healthy incident-sized run", async () => {
  // Enough transcript to actually need several chunks at a 32768 context —
  // roughly the shape of the run that stalled on 2026-08-12.
  const h = harness({ contextSize: 32768, segments: manySegments(200) });
  const result = await runNoteAction(h.options);
  assert.ok(result.passes > 1);
  assert.ok(h.calls.length > 1);
});

test("compose output is clamped to the resolved context", async () => {
  // 2048 output tokens at a 2048 context leaves nothing for the prompt.
  const h = harness({ contextSize: 2048, segments: manySegments(4, 200) });
  await runNoteAction(h.options);
  const compose = h.calls[h.calls.length - 1];
  assert.ok(compose.opts.maxTokens < 2048, "output cannot claim the whole context");
  assert.ok(compose.opts.maxTokens > 0);
});

test("exceeding the run deadline aborts with a typed error", async () => {
  let now = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      now += 60_000;
      return "out";
    },
  });
  h.options.deadlineMs = 90_000;
  h.options.now = () => now;

  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_MULTIPASS_TIMEOUT"
  );
});

test("a normal run is unaffected by the deadline", async () => {
  let now = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      now += 1000;
      return "out";
    },
  });
  h.options.deadlineMs = 30 * 60_000;
  h.options.now = () => now;
  const result = await runNoteAction(h.options);
  assert.ok(result.text);
});

test("a timeout is retried once, not three times", async () => {
  let n = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      n++;
      throw coded("llama-server request timed out", "LLAMA_REQUEST_TIMEOUT");
    },
  });
  await assert.rejects(() => runNoteAction(h.options), (err) => err.code === "LOCAL_MULTIPASS_FAILED");
  assert.equal(n, 2, "a request that already burned the full timeout is not a blip");
});

test("a startup failure is retried at most twice", async () => {
  let n = 0;
  const h = harness({
    segments: manySegments(24),
    infer: async () => {
      n++;
      throw coded("died during startup (signal: SIGKILL)", "LLAMA_START_FAILED");
    },
  });
  await assert.rejects(() => runNoteAction(h.options));
  assert.equal(n, 2, "four consecutive 5.4GB model loads under thrash is not a retry policy");
});

test("a pass far slower than the established median aborts the run", async () => {
  // Passes 1 and 2 took 43s and 40s in the 2026-08-12 incident; pass 3 was
  // still going at 88s. A machine whose passes are stretching is thrashing,
  // and running passes 4 and 5 into it only prolongs the stall.
  let now = 0;
  let n = 0;
  const h = harness({
    segments: manySegments(600),
    contextSize: 32768,
    infer: async () => {
      n++;
      now += n >= 3 ? 400_000 : 40_000;
      return "out";
    },
  });
  h.options.now = () => now;

  await assert.rejects(
    () => runNoteAction(h.options),
    (err) => err.code === "LOCAL_MULTIPASS_DEGRADED"
  );
});

test("the degradation check needs a median before it can fire", async () => {
  // One slow pass with nothing to compare against must not abort the run.
  let now = 0;
  let n = 0;
  const h = harness({
    segments: manySegments(600),
    contextSize: 32768,
    infer: async () => {
      n++;
      now += n === 1 ? 300_000 : 1000;
      return "out";
    },
  });
  h.options.now = () => now;
  const result = await runNoteAction(h.options);
  assert.ok(result.text);
});

test("normal pass-to-pass variation does not abort", async () => {
  let now = 0;
  const times = [40_000, 43_000, 51_000, 39_000, 47_000, 60_000];
  let i = 0;
  const h = harness({
    segments: manySegments(600),
    contextSize: 32768,
    infer: async () => {
      now += times[i++ % times.length];
      return "out";
    },
  });
  h.options.now = () => now;
  const result = await runNoteAction(h.options);
  assert.ok(result.text);
});
