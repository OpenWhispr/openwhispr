const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../../src/helpers/llamaContextPolicy");

// --- estimateTokens ------------------------------------------------------
//
// Used before any llama-server exists, to pick the context size the server
// starts at. Once a server is up, POST /tokenize gives an exact count in ~13ms
// and supersedes this. The estimate must therefore be cheap and biased HIGH:
// over-estimating costs KV bytes (bounded by the ceiling), under-estimating
// costs a restart, and under-estimating badly is the bug being fixed (#2142).

test("estimateTokens counts Latin text at three characters per token", () => {
  assert.equal(policy.estimateTokens("abcdef"), 2);
  assert.equal(policy.estimateTokens("abcd"), 2); // rounds up, never down
  assert.equal(policy.estimateTokens(""), 0);
});

test("estimateTokens over-estimates a real transcript rather than under-estimating it", () => {
  // Measured against the bundled llama-server (b9763) POST /tokenize with
  // Qwen3.5-9B: an 85,171-character synthetic meeting transcript tokenized to
  // 20,473 tokens (4.16 chars/token). A chars/4 constant would sit right on
  // that line and under-estimate real transcripts; chars/3 leaves headroom.
  const transcript = "a".repeat(85171);
  const estimate = policy.estimateTokens(transcript);

  assert.ok(estimate > 20473, `expected the estimate to exceed the real count, got ${estimate}`);
  assert.ok(estimate < 20473 * 2, `expected the estimate to stay within 2x, got ${estimate}`);
});

test("estimateTokens counts CJK at one token per codepoint", () => {
  // ja, zh-CN and zh-TW all ship. CJK tokenizes at roughly 1-1.5 chars/token,
  // so a global chars/3 constant under-counts a Japanese transcript ~3x and
  // would silently reintroduce #2142 for those users.
  assert.equal(policy.estimateTokens("会議の議事録"), 6);
  assert.equal(policy.estimateTokens("ひらがな"), 4);
  assert.equal(policy.estimateTokens("한국어"), 3);
});

test("estimateTokens charges CJK strictly more than Latin for the same length", () => {
  const latin = policy.estimateTokens("x".repeat(300));
  const cjk = policy.estimateTokens("会".repeat(300));

  assert.ok(cjk > latin, `expected CJK (${cjk}) to cost more than Latin (${latin})`);
});

test("estimateTokens sums mixed scripts instead of picking one rate", () => {
  assert.equal(policy.estimateTokens("会議abcdef"), 2 + 2);
});

test("estimateTokens treats absent or non-string input as zero", () => {
  assert.equal(policy.estimateTokens(null), 0);
  assert.equal(policy.estimateTokens(undefined), 0);
  assert.equal(policy.estimateTokens(12345), 0);
});

// --- kvBytesPerToken -----------------------------------------------------
//
// The whole point of the fix. KV cost is exactly linear in context size, but
// varies ~12x across the bundled registry and is ANTI-correlated with model
// file size, so no ceiling based on RAM tiers, file size or parameter count is
// sound. It has to come from the model's own architecture.

test("kvBytesPerToken reproduces the measured cost of the #1203 model", () => {
  // Llama-3.2-3B-Instruct-Q4_K_M: 28 blocks, 8 KV heads, 128-wide K and V.
  // 28 * 8 * (128+128) * 2 bytes (f16) = 114688 = 112 KiB/token, which is what
  // made its full 131072 context a ~15 GB KV cache on a 16 GB Mac.
  const bytes = policy.kvBytesPerToken({
    blockCount: 28,
    headCountKv: 8,
    keyLength: 128,
    valueLength: 128,
  });

  assert.equal(bytes, 114688);
  assert.equal(bytes * 131072, 15032385536); // ~15.0 GB, the #1203 allocation
});

test("kvBytesPerToken is anti-correlated with file size across the registry", () => {
  // Qwen3.5-9B is a 5.9 GB file; Llama-3.2-3B is a 2.0 GB file. The smaller
  // model costs far more per token. This is the fact that rules out every
  // size-based or RAM-tier heuristic.
  const qwen9b = policy.kvBytesPerToken({
    blockCount: 33,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
  });
  const llama3b = policy.kvBytesPerToken({
    blockCount: 28,
    headCountKv: 8,
    keyLength: 128,
    valueLength: 128,
  });

  assert.equal(qwen9b, 135168);
  assert.ok(llama3b < qwen9b, "the 3B is cheaper per token than the 9B by this bound");
  // The bound is deliberately conservative for Qwen3.5: it interleaves full
  // attention every 4th layer, so the measured cost is 32768 B/token (512 MiB
  // at 16384 ctx). Over-estimating shrinks the ceiling, which is the safe way
  // to be wrong.
  assert.ok(qwen9b > 32768, "full-attention bound must not undercut the measured cost");
});

test("kvBytesPerToken takes the largest layer when head_count_kv varies per layer", () => {
  // GGUF allows a per-layer array. The max is the safe reading.
  const bytes = policy.kvBytesPerToken({
    blockCount: 4,
    headCountKv: [2, 8, 2, 2],
    keyLength: 128,
    valueLength: 128,
  });

  assert.equal(bytes, 4 * 8 * 256 * 2);
});

test("kvBytesPerToken derives head width from the embedding when it is not declared", () => {
  // key_length/value_length are optional; llama.cpp falls back to
  // embedding_length / head_count.
  const bytes = policy.kvBytesPerToken({
    blockCount: 28,
    headCountKv: 8,
    embeddingLength: 3072,
    headCount: 24, // 3072 / 24 = 128
  });

  assert.equal(bytes, 114688);
});

test("kvBytesPerToken returns null rather than guessing when the architecture is unreadable", () => {
  // A null here must fall back to today's 16384 ceiling, never to a bigger
  // number derived from incomplete data.
  assert.equal(policy.kvBytesPerToken(null), null);
  assert.equal(policy.kvBytesPerToken({}), null);
  assert.equal(policy.kvBytesPerToken({ blockCount: 28 }), null);
  assert.equal(policy.kvBytesPerToken({ blockCount: 28, headCountKv: 8 }), null);
  assert.equal(policy.kvBytesPerToken({ blockCount: 0, headCountKv: 8, keyLength: 128 }), null);
});

// --- resolveContextCeiling -----------------------------------------------
//
// The largest context this machine may allocate for this model. This is the
// function that has to keep the #1203 promise: it is the only thing standing
// between a long transcript and a wired KV cache big enough to freeze a Mac.

const GIB = 1024 * 1024 * 1024;

const LLAMA_3_2_3B = {
  // 28 blocks, 8 KV heads, 128-wide -> 114688 B/token. The #1203 model.
  kvBytesPerToken: 114688,
  weightsBytes: 2168958976,
  trainedContextTokens: 131072,
};

const QWEN_3_5_9B = {
  kvBytesPerToken: 135168,
  weightsBytes: 6169341984,
  trainedContextTokens: 262144,
  hasRecurrentState: true,
};

test("regression #1203: a 16 GB Mac running Llama-3.2-3B stays far below the allocation that panicked", () => {
  const { ceiling } = policy.resolveContextCeiling({
    totalMemoryBytes: 16 * GIB,
    ...LLAMA_3_2_3B,
  });

  assert.equal(ceiling, 32256);

  // The actual guarantee, stated as memory rather than as a magic number: the
  // resident footprint must stay well under half the machine, so macOS keeps
  // room it can compress or swap. #1203 allocated ~15 GB of 16 GB as WIRED
  // Metal memory, which can do neither, and watchdogd missed its check-ins.
  const footprint =
    LLAMA_3_2_3B.weightsBytes + ceiling * LLAMA_3_2_3B.kvBytesPerToken + policy.COMPUTE_FIXED_BYTES;
  assert.ok(
    footprint < 0.4 * 16 * GIB,
    `footprint ${footprint} must stay under 40% of RAM (${0.4 * 16 * GIB})`
  );

  // And it must still be a real improvement, or the bug is not fixed.
  assert.ok(ceiling > policy.BASELINE_CONTEXT_SIZE, "must beat today's flat 16384");
});

test("the ceiling tracks KV cost, not model size, on identical hardware", () => {
  // Same machine, same weights, only the per-token cost differs by 12x. A
  // RAM-tier or file-size heuristic would return the same answer for both.
  const cheap = policy.resolveContextCeiling({
    totalMemoryBytes: 48 * GIB,
    kvBytesPerToken: 32768,
    weightsBytes: 5 * GIB,
    trainedContextTokens: 262144,
  });
  const expensive = policy.resolveContextCeiling({
    totalMemoryBytes: 48 * GIB,
    kvBytesPerToken: 393216, // Gemma-3-12B
    weightsBytes: 5 * GIB,
    trainedContextTokens: 131072,
  });

  assert.ok(
    cheap.ceiling > expensive.ceiling * 3,
    `expected a wide split, got ${cheap.ceiling} vs ${expensive.ceiling}`
  );
});

test("the reported 48 GB machine can hold the transcript that fails today", () => {
  const { ceiling } = policy.resolveContextCeiling({
    totalMemoryBytes: 48 * GIB,
    ...QWEN_3_5_9B,
  });

  assert.equal(ceiling, 118272);
  // The customer's prompt measured 20,514 tokens against the bundled server.
  assert.ok(ceiling > 20514 + 2048, "the failing request must now fit with output headroom");
});

test("an unreadable architecture falls back to today's limit, never to a larger guess", () => {
  const { ceiling, reason } = policy.resolveContextCeiling({
    totalMemoryBytes: 48 * GIB,
    kvBytesPerToken: null,
    weightsBytes: 2168958976,
    trainedContextTokens: 131072,
  });

  assert.equal(ceiling, policy.BASELINE_CONTEXT_SIZE);
  assert.equal(reason, "unknown-kv-cost");
});

test("unusable memory readings fall back to today's limit", () => {
  for (const totalMemoryBytes of [0, Number.NaN, undefined, null, -1]) {
    const { ceiling, reason } = policy.resolveContextCeiling({
      totalMemoryBytes,
      ...LLAMA_3_2_3B,
    });
    assert.equal(ceiling, policy.BASELINE_CONTEXT_SIZE, `total=${totalMemoryBytes}`);
    assert.equal(reason, "no-memory-info");
  }
});

test("a machine too small for any headroom keeps exactly today's behaviour", () => {
  // 8 GB Mac, 2 GB of weights: the budget goes negative. This must be the
  // historical 16384 rather than something smaller, so the change can never
  // make a shipping configuration worse.
  const { ceiling, reason } = policy.resolveContextCeiling({
    totalMemoryBytes: 8 * GIB,
    ...LLAMA_3_2_3B,
  });

  assert.equal(ceiling, policy.BASELINE_CONTEXT_SIZE);
  assert.equal(reason, "floor");
});

test("the ceiling never exceeds what the model was trained for", () => {
  const { ceiling, reason } = policy.resolveContextCeiling({
    totalMemoryBytes: 512 * GIB,
    kvBytesPerToken: 32768,
    weightsBytes: 5 * GIB,
    trainedContextTokens: 32768,
  });

  assert.equal(ceiling, 32768);
  assert.equal(reason, "trained-context-bound");
});

test("an unmeasured discrete GPU is capped even when system RAM looks generous", () => {
  const { ceiling } = policy.resolveContextCeiling({
    totalMemoryBytes: 128 * GIB,
    kvBytesPerToken: 32768,
    weightsBytes: 3 * GIB,
    trainedContextTokens: 262144,
    discreteGpuUnverified: true,
  });

  assert.ok(ceiling <= 65536, `expected the unverified-GPU cap, got ${ceiling}`);
});

test("the ceiling moves monotonically with each input", () => {
  const base = { totalMemoryBytes: 32 * GIB, ...LLAMA_3_2_3B };
  const at = (overrides) => policy.resolveContextCeiling({ ...base, ...overrides }).ceiling;

  assert.ok(at({ totalMemoryBytes: 64 * GIB }) >= at({}), "more RAM never shrinks the ceiling");
  assert.ok(at({ weightsBytes: 6 * GIB }) <= at({}), "bigger weights never grow the ceiling");
  assert.ok(at({ kvBytesPerToken: 393216 }) <= at({}), "costlier KV never grows the ceiling");
  assert.ok(at({ hasRecurrentState: true }) <= at({}), "recurrent state never grows the ceiling");
  assert.ok(at({ draftWeightsBytes: 2 * GIB }) <= at({}), "a drafter never grows the ceiling");
});

test("the prompt cache is bounded so it cannot eat the budget we just computed", () => {
  // llama-server defaults --cache-ram to 8192 MiB of host RAM, on top of the
  // KV cache and 32 context checkpoints per slot. Unbounded, it would undo the
  // budget. Cap it rather than disabling it: 0 forces a full re-prefill on
  // every request.
  for (const totalMemoryBytes of [8 * GIB, 16 * GIB, 48 * GIB, 128 * GIB]) {
    const { cacheRamMiB } = policy.resolveContextCeiling({
      totalMemoryBytes,
      ...LLAMA_3_2_3B,
    });
    assert.ok(
      cacheRamMiB >= 512 && cacheRamMiB <= 2048,
      `cacheRamMiB ${cacheRamMiB} out of range at ${totalMemoryBytes}`
    );
  }
});

// --- resolveContextSize --------------------------------------------------
//
// Snapping to a ladder is what keeps restarts bounded. Sizing the context to
// the exact request would restart the server for a 20,600-token note and again
// for a 21,100-token one; snapping puts both on the same rung.

test("resolveContextSize keeps short requests on the baseline rung", () => {
  assert.equal(policy.resolveContextSize({ needed: 800, ceiling: 131072 }), 16384);
  assert.equal(policy.resolveContextSize({ needed: 0, ceiling: 131072 }), 16384);
  assert.equal(policy.resolveContextSize({ ceiling: 131072 }), 16384);
});

test("resolveContextSize grows to the smallest rung that fits the request", () => {
  // The reported failure: 20,514 prompt tokens plus output and template slack.
  assert.equal(policy.resolveContextSize({ needed: 23074, ceiling: 131072 }), 32768);
  assert.equal(policy.resolveContextSize({ needed: 16385, ceiling: 131072 }), 32768);
  assert.equal(policy.resolveContextSize({ needed: 32768, ceiling: 131072 }), 32768);
  assert.equal(policy.resolveContextSize({ needed: 32769, ceiling: 131072 }), 65536);
});

test("resolveContextSize puts near-identical requests on the same rung", () => {
  const first = policy.resolveContextSize({ needed: 20600, ceiling: 131072 });
  const second = policy.resolveContextSize({ needed: 21100, ceiling: 131072 });

  assert.equal(first, second, "a second similar note must not cost a second restart");
});

test("resolveContextSize never returns more than the ceiling allows", () => {
  // The #1203 machine: the ceiling is not on a rung, and it wins outright.
  assert.equal(policy.resolveContextSize({ needed: 40000, ceiling: 32256 }), 32256);
  assert.equal(policy.resolveContextSize({ needed: 1000000, ceiling: 32256 }), 32256);
  assert.equal(policy.resolveContextSize({ needed: 100000, ceiling: 65536 }), 65536);
});

test("resolveContextSize honours a caller floor without breaching the ceiling", () => {
  // Selection editing asks for a larger window up front (audioManager.js).
  assert.equal(policy.resolveContextSize({ needed: 500, floor: 32768, ceiling: 131072 }), 32768);
  // ...but a caller cannot talk its way past the memory guard.
  assert.equal(policy.resolveContextSize({ needed: 500, floor: 262144, ceiling: 32256 }), 32256);
});

test("resolveContextSize never drops below the baseline even with a tiny ceiling", () => {
  assert.equal(policy.resolveContextSize({ needed: 100, ceiling: 4096 }), 16384);
});
