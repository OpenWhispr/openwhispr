const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readGgufMetadata, kvBytesPerToken, kvCacheBytes } = require("../../src/helpers/ggufMetadata");
const { resolveContextSize, PROMPT_SHARE } = require("../../src/helpers/llamaContext");

// llama-server was started with no --ctx-size, so it used the model's own trained
// context — 131072 tokens for the Gemma the user runs. For that model's geometry
// that is ~14 GB of KV cache next to 5 GB of weights on a 24 GB machine, which is
// what made the whole machine unresponsive.

// Geometry of google_gemma-4-E4B-it-Q4_K_M, read from the real file during the
// investigation. 42 layers x 2 KV heads x head_dim 320.
const GEMMA = {
  contextLength: 131072,
  blockCount: 42,
  headCountKv: 2,
  headCount: 8,
  embeddingLength: 2560,
};

const GIB = 1024 ** 3;

function writeGguf(filePath, spec) {
  const {
    contextLength,
    blockCount,
    headCountKv,
    headCount,
    embeddingLength,
    keyLength,
    valueLength,
    keyLengthSwa,
    valueLengthSwa,
    slidingWindow,
    swaLayerCount,
  } = spec;
  const chunks = [];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);
  const i32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return b;
  };
  // Negative values exist in the wild only as corruption, but the reader reads
  // these as signed, so a fixture must be able to write one.
  const kvU32 = (key, value) =>
    value < 0
      ? Buffer.concat([str(key), u32(5), i32(value)])
      : Buffer.concat([str(key), u32(4), u32(value)]);

  // A type-7 (bool) array, the shape sliding_window_pattern really uses.
  const kvBoolArray = (key, values) =>
    Buffer.concat([
      str(key),
      u32(9),
      u32(7),
      u64(values.length),
      Buffer.from(values.map((v) => (v ? 1 : 0))),
    ]);

  const entries = [
    kvU32("test.context_length", contextLength),
    kvU32("test.block_count", blockCount),
    kvU32("test.attention.head_count_kv", headCountKv),
    kvU32("test.attention.head_count", headCount),
    kvU32("test.embedding_length", embeddingLength),
  ];

  const optional = {
    "test.attention.key_length": keyLength,
    "test.attention.value_length": valueLength,
    "test.attention.key_length_swa": keyLengthSwa,
    "test.attention.value_length_swa": valueLengthSwa,
    "test.attention.sliding_window": slidingWindow,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) entries.push(kvU32(key, value));
  }

  if (swaLayerCount !== undefined) {
    // Gemma's real pattern: every sixth layer is global, the rest slide.
    const pattern = Array.from({ length: blockCount }, (_, i) => i % 6 !== 5);
    entries.push(kvBoolArray("test.attention.sliding_window_pattern", pattern));
  }

  // Everything the reader wants precedes the tokenizer block in a real file.
  entries.push(kvU32("tokenizer.ggml.bos_token_id", 2));

  chunks.push(Buffer.from("GGUF", "ascii"), u32(3), u64(0), u64(entries.length), ...entries);
  fs.writeFileSync(filePath, Buffer.concat(chunks));
}

test("reads the trained context and geometry out of a GGUF header", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-"));
  const file = path.join(dir, "model.gguf");
  writeGguf(file, GEMMA);

  const meta = readGgufMetadata(file);

  assert.equal(meta.contextLength, 131072);
  assert.equal(meta.blockCount, 42);
  assert.equal(meta.headCountKv, 2);
  assert.equal(meta.headDim, 320, "embedding_length / head_count");
});

test("a file that is not a GGUF returns null rather than throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-"));
  const file = path.join(dir, "not-a-model.gguf");
  fs.writeFileSync(file, "this is not a model");

  assert.equal(readGgufMetadata(file), null);
});

test("a missing file returns null rather than throwing", () => {
  assert.equal(readGgufMetadata("/nope/does/not/exist.gguf"), null);
});

test("KV bytes per token follows the model geometry", () => {
  // 42 layers x (K and V) x (2 kv heads x 320) x 2 bytes (f16)
  assert.equal(kvBytesPerToken(GEMMA), 42 * 2 * 640 * 2);
});

test("the machine that hung now gets a context it can actually hold", () => {
  const resolved = resolveContextSize({
    gguf: GEMMA,
    totalMemBytes: 24 * GIB,
    modelFileBytes: 5 * GIB,
  });

  assert.ok(resolved.contextSize >= 8192, `too small to be useful: ${resolved.contextSize}`);
  assert.ok(
    resolved.contextSize < GEMMA.contextLength,
    "the whole point is to stop using the model's full 131072"
  );
  assert.ok(
    resolved.estimatedKvBytes < 6 * GIB,
    `KV must fit alongside the weights, got ${(resolved.estimatedKvBytes / GIB).toFixed(1)}GB`
  );
});

test("the caller's requested context cannot raise the resolved value", () => {
  // The registry claims 262144 for this model — twice what the GGUF says — and the
  // inference path asks for 4096. Neither may decide the allocation.
  const high = resolveContextSize({
    gguf: GEMMA,
    totalMemBytes: 24 * GIB,
    modelFileBytes: 5 * GIB,
    requested: 262144,
  });
  const low = resolveContextSize({
    gguf: GEMMA,
    totalMemBytes: 24 * GIB,
    modelFileBytes: 5 * GIB,
    requested: 4096,
  });

  assert.equal(high.contextSize, low.contextSize, "the resolved context must be deterministic");
});

test("the resolved context never exceeds what the model was trained for", () => {
  const small = { ...GEMMA, contextLength: 8192 };
  const resolved = resolveContextSize({
    gguf: small,
    totalMemBytes: 64 * GIB,
    modelFileBytes: 1 * GIB,
  });

  assert.equal(resolved.contextSize, 8192, "asking past the trained context degrades quality");
});

test("a small model on a small machine keeps a usable context", () => {
  // A tiny model's KV is cheap; capping it by a RAM tier would break setups that
  // work today.
  const tiny = {
    contextLength: 32768,
    blockCount: 24,
    headCountKv: 2,
    headCount: 14,
    embeddingLength: 896,
  };
  const resolved = resolveContextSize({
    gguf: tiny,
    totalMemBytes: 8 * GIB,
    modelFileBytes: 1 * GIB,
  });

  assert.equal(resolved.contextSize, 32768, "a cheap KV should still get its full context");
});

test("an unreadable header still yields a safe bounded context", () => {
  const resolved = resolveContextSize({
    gguf: null,
    totalMemBytes: 24 * GIB,
    modelFileBytes: 5 * GIB,
  });

  assert.ok(resolved.contextSize >= 2048 && resolved.contextSize <= 32768);
  assert.equal(resolved.source, "fallback");
});

test("the resolution explains itself for the log", () => {
  const resolved = resolveContextSize({
    gguf: GEMMA,
    totalMemBytes: 24 * GIB,
    modelFileBytes: 5 * GIB,
  });

  assert.equal(typeof resolved.estimatedKvBytes, "number");
  assert.equal(typeof resolved.kvBytesPerToken, "number");
  assert.equal(resolved.trainedContext, 131072);
  assert.ok(resolved.source);
});

// ── Available-memory bound (1.16.1) ────────────────────────────────────────

test("the incident case: 24GB total but 3.7GB available does not resolve 32768", () => {
  // The exact numbers from the 2026-08-12 stall. 1.16.0 resolved 32768 here and
  // reserved 3.5GB of KV on a machine with 3.7GB left, which put it into swap.
  const gguf = { contextLength: 131072, blockCount: 42, headCountKv: 2, embeddingLength: 2560, headCount: 8 };
  const before = resolveContextSize({
    gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384,
  });
  assert.equal(before.contextSize, 32768, "guard: this is what shipped and stalled");

  const after = resolveContextSize({
    gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384,
    availableMemBytes: 3.7 * 1024 ** 3,
  });
  assert.ok(after.contextSize < before.contextSize, "must not claim memory that is not there");
  assert.equal(after.source, "available-bound");
});

test("a machine with plenty available reproduces today's answer exactly", () => {
  const gguf = { contextLength: 131072, blockCount: 42, headCountKv: 2, embeddingLength: 2560, headCount: 8 };
  const without = resolveContextSize({ gguf, totalMemBytes: 68719476736, modelFileBytes: 5405168384 });
  const with_ = resolveContextSize({
    gguf, totalMemBytes: 68719476736, modelFileBytes: 5405168384,
    availableMemBytes: 40 * 1024 ** 3,
  });
  assert.equal(with_.contextSize, without.contextSize, "no regression on a healthy machine");
});

test("the total-RAM ceiling still binds when available memory is huge", () => {
  const gguf = { contextLength: 131072, blockCount: 42, headCountKv: 2, embeddingLength: 2560, headCount: 8 };
  const capped = resolveContextSize({
    gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384,
    availableMemBytes: 24 * 1024 ** 3,
  });
  const total = resolveContextSize({ gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384 });
  assert.equal(capped.contextSize, total.contextSize, "never hog a machine just because it is idle");
});

test("omitting availableMemBytes behaves exactly as before", () => {
  const gguf = { contextLength: 131072, blockCount: 42, headCountKv: 2, embeddingLength: 2560, headCount: 8 };
  const a = resolveContextSize({ gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384 });
  const b = resolveContextSize({
    gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384, availableMemBytes: undefined,
  });
  assert.deepEqual(a, b);
});

test("weights are not subtracted when the server is already running", () => {
  // Available memory already excludes a resident model; subtracting the file
  // size again double-counts and collapses the context to the floor.
  const gguf = { contextLength: 131072, blockCount: 42, headCountKv: 2, embeddingLength: 2560, headCount: 8 };
  const cold = resolveContextSize({
    gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384,
    availableMemBytes: 8 * 1024 ** 3,
  });
  const warm = resolveContextSize({
    gguf, totalMemBytes: 25769803776, modelFileBytes: 5405168384,
    availableMemBytes: 8 * 1024 ** 3, modelAlreadyResident: true,
  });
  assert.ok(warm.contextSize >= cold.contextSize);
});

// ── Sliding-window models (1.17.0) ─────────────────────────────────────────
//
// Measured by running the bundled llama-server against the real
// google_gemma-4-E4B-it-Q4_K_M.gguf with LLAMA_ARG_FIT=off (the app's own flag):
//
//   --ctx-size 4096    non-SWA  64 MiB (4 layers) + SWA 100 MiB (20 layers) =  164 MiB
//   --ctx-size 32768   non-SWA 512 MiB (4 layers) + SWA 100 MiB (20 layers) =  612 MiB
//   --ctx-size 131072  non-SWA 2048 MiB (4 layers) + SWA 100 MiB (20 layers) = 2148 MiB
//
// The old formula priced all 42 layers as growing with n_ctx, at 107520 B/token —
// 6.3x the truth at 131072, which is what collapsed the context to 2048.
const MIB = 1024 ** 2;

const GEMMA_SWA = {
  ...GEMMA,
  keyLength: 512,
  valueLength: 512,
  keyLengthSwa: 256,
  valueLengthSwa: 256,
  slidingWindow: 512,
  swaLayerCount: 35,
};

const MEASURED_KV_MIB = { 4096: 164, 32768: 612, 131072: 2148 };

test("the SWA split is read out of a real GGUF header", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-swa-"));
  const file = path.join(dir, "model.gguf");
  writeGguf(file, GEMMA_SWA);

  const meta = readGgufMetadata(file);

  assert.equal(meta.keyLength, 512);
  assert.equal(meta.valueLength, 512);
  assert.equal(meta.keyLengthSwa, 256);
  assert.equal(meta.valueLengthSwa, 256);
  assert.equal(meta.slidingWindow, 512);
  assert.equal(meta.swaLayerCount, 35, "35 of 42 layers slide; 7 are global");
});

test("KV cache size tracks what llama.cpp actually allocates", () => {
  // Pinned to this formula's own values, each with a >= measured floor so the
  // estimate can never drift under reality.
  const expected = { 4096: 392 * MIB, 32768: 1176 * MIB, 131072: 3864 * MIB };

  for (const ctx of [4096, 32768, 131072]) {
    const bytes = kvCacheBytes(GEMMA_SWA, ctx);
    assert.equal(bytes, expected[ctx], `ctx ${ctx}`);
    assert.ok(
      bytes >= MEASURED_KV_MIB[ctx] * MIB,
      `ctx ${ctx}: estimate must never fall under the measured ${MEASURED_KV_MIB[ctx]} MiB`
    );
    assert.ok(
      bytes <= MEASURED_KV_MIB[ctx] * MIB * 3,
      `ctx ${ctx}: ${(bytes / MIB).toFixed(0)} MiB is more than 3x the measured cost`
    );
  }
});

test("the sliding-window cache does not grow with the context", () => {
  // 20 layers x 2560 cells, fixed, whether n_ctx is 4096 or 131072. The growing
  // part must therefore be linear once the SWA term has saturated.
  const a = kvCacheBytes(GEMMA_SWA, 32768);
  const b = kvCacheBytes(GEMMA_SWA, 65536);
  const c = kvCacheBytes(GEMMA_SWA, 98304);

  assert.equal(b - a, c - b, "equal steps of n_ctx must cost equally");
  assert.equal(b - a, 32768 * kvBytesPerToken(GEMMA_SWA), "only the global layers grow");
});

test("the reported machine gets a context it can actually use", () => {
  // The exact inputs logged at 2026-09-02T21:15:21Z, which resolved 2048 and made
  // every "Generating notes" step fail with "budget of 1228".
  const resolved = resolveContextSize({
    gguf: GEMMA_SWA,
    totalMemBytes: 25769803776,
    modelFileBytes: 5405168384,
    availableMemBytes: 5292244992,
  });

  assert.equal(resolved.contextSize, 16384);
  assert.ok(
    Math.floor(resolved.contextSize * PROMPT_SHARE) > 2871,
    "must clear the notes prompt: 648 system tokens + 2223 of transcript"
  );
});

test("a pattern without a sliding window is priced as all-global", () => {
  // The unsafe direction. A header claiming an SWA pattern but no window would
  // otherwise price most layers at a small fixed cost when they really grow with
  // n_ctx — under-estimating, which is what drove the machine into swap.
  const noWindow = { ...GEMMA_SWA, slidingWindow: 0 };
  const allGlobal = { ...GEMMA_SWA, swaLayerCount: 0, slidingWindow: 0 };

  assert.equal(kvCacheBytes(noWindow, 32768), kvCacheBytes(allGlobal, 32768));
  assert.ok(kvCacheBytes(noWindow, 32768) > kvCacheBytes(GEMMA_SWA, 32768));
});

test("a header with none of the SWA keys resolves exactly as it does today", () => {
  const before = resolveContextSize({
    gguf: GEMMA,
    totalMemBytes: 25769803776,
    modelFileBytes: 5405168384,
  });

  assert.equal(before.contextSize, 32768, "no SWA keys: unchanged from 1.16.1");
  assert.equal(kvBytesPerToken(GEMMA), 42 * 2 * 640 * 2, "falls back to embedding/head_count");
});

test("a GGUF whose header stops before the SWA keys still parses", () => {
  // The reader breaks out of the scan early. Adding five more wanted keys must
  // not make a model that reads fine today fall back to null.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-nosw-"));
  const file = path.join(dir, "model.gguf");
  writeGguf(file, GEMMA);

  const meta = readGgufMetadata(file);

  assert.ok(meta, "must not return null");
  assert.equal(meta.blockCount, 42);
  assert.equal(meta.swaLayerCount, 0, "absent pattern means no sliding layers");
});

test("the KV floor scales with the weights we are already committing to load", () => {
  // A flat 256MB floor is what pinned the reporting machine to 2048: whenever the
  // model is larger than 0.8x available, the available bound goes negative and
  // clamps there. Refusing 0.8GB of KV next to a 5.4GB weights allocation is
  // incoherent — the far larger commitment has already been made.
  const starved = resolveContextSize({
    gguf: GEMMA_SWA,
    totalMemBytes: 25769803776,
    modelFileBytes: 5405168384,
    availableMemBytes: 1 * GIB,
  });

  assert.ok(starved.contextSize >= 8192, `floored too low: ${starved.contextSize}`);
  assert.ok(
    starved.kvBudgetBytes >= Math.floor(0.15 * 5405168384),
    "the floor must be proportional to the weights"
  );
});

test("the floor never exceeds the polite total-RAM allowance", () => {
  // A model too large for the machine tier must not have a large floor forced on
  // it by its own size.
  const huge = resolveContextSize({
    gguf: GEMMA_SWA,
    totalMemBytes: 8 * GIB,
    modelFileBytes: 7 * GIB,
    availableMemBytes: 512 * 1024 ** 2,
  });

  assert.ok(
    huge.kvBudgetBytes <= Math.max(268435456, Math.floor(8 * GIB * 0.35) - 7 * GIB),
    `floor escaped the total-RAM ceiling: ${huge.kvBudgetBytes}`
  );
});

test("a pattern claiming more sliding layers than the model has cannot go negative", () => {
  // GGUF files are downloaded, not authored here. A pattern longer than
  // block_count would make the global-layer count negative, the estimated cache
  // negative, and every context "affordable" — handing back the full trained
  // 131072, which is the ~14GB allocation that stalled the machine in August.
  const corrupt = { ...GEMMA_SWA, swaLayerCount: 50 };

  assert.ok(kvCacheBytes(corrupt, 131072) > 0, "a cache size can never be negative");

  const resolved = resolveContextSize({
    gguf: corrupt,
    totalMemBytes: 25769803776,
    modelFileBytes: 5405168384,
    availableMemBytes: 5292244992,
  });

  assert.ok(
    resolved.contextSize < corrupt.contextLength,
    `a corrupt header must not unlock the full trained context: ${resolved.contextSize}`
  );
  assert.ok(resolved.estimatedKvBytes > 0);
});

test("every layer sliding is priced as a genuinely fixed cache", () => {
  const allSliding = { ...GEMMA_SWA, swaLayerCount: GEMMA_SWA.blockCount };

  assert.equal(kvBytesPerToken(allSliding), 0, "nothing grows with the context");
  assert.equal(kvCacheBytes(allSliding, 4096), kvCacheBytes(allSliding, 131072));
});

test("a header with a nonsensical geometry is unreadable rather than NaN", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-neg-"));
  const file = path.join(dir, "model.gguf");
  // -1 survives `!found.contextLength`, then rounds to NaN and reaches
  // llama-server as `--ctx-size NaN`.
  writeGguf(file, { ...GEMMA, contextLength: -1 });

  assert.equal(readGgufMetadata(file), null);
});

test("an unreadable geometry never resolves a NaN context", () => {
  for (const broken of [
    { ...GEMMA, contextLength: -1 },
    { ...GEMMA, blockCount: 0 },
    { ...GEMMA, headCountKv: -2 },
  ]) {
    const resolved = resolveContextSize({
      gguf: broken,
      totalMemBytes: 25769803776,
      modelFileBytes: 5405168384,
    });
    assert.ok(
      Number.isInteger(resolved.contextSize) && resolved.contextSize >= 2048,
      `got ${resolved.contextSize} for ${JSON.stringify(broken)}`
    );
  }
});

test("a corrupt optional dimension cannot buy a bigger context than an honest header", () => {
  // The optional keys are read as signed int32s too. A negative key_length shrinks
  // the per-token cost and makes every context look affordable — the same
  // unacceptable direction as the negative layer count, by a different field.
  const honest = resolveContextSize({
    gguf: GEMMA_SWA,
    totalMemBytes: 25769803776,
    modelFileBytes: 5405168384,
    availableMemBytes: 5292244992,
  });

  for (const field of [
    "keyLength",
    "valueLength",
    "keyLengthSwa",
    "valueLengthSwa",
    "slidingWindow",
  ]) {
    for (const bogus of [-500, 0, 1.5]) {
      const resolved = resolveContextSize({
        gguf: { ...GEMMA_SWA, [field]: bogus },
        totalMemBytes: 25769803776,
        modelFileBytes: 5405168384,
        availableMemBytes: 5292244992,
      });
      assert.ok(
        resolved.contextSize <= honest.contextSize,
        `${field}=${bogus} bought ${resolved.contextSize} against an honest ${honest.contextSize}`
      );

      // The context is only the visible half. The invariant underneath is that a
      // corrupt header can never be priced more cheaply than an honest one — it
      // must either cost at least as much, or be refused outright (zero, which
      // sends the caller to the fixed fallback context).
      const corruptCost = kvCacheBytes({ ...GEMMA_SWA, [field]: bogus }, 32768);
      assert.ok(
        corruptCost === 0 || corruptCost >= kvCacheBytes(GEMMA_SWA, 32768),
        `${field}=${bogus} priced at ${corruptCost}, under an honest ${kvCacheBytes(GEMMA_SWA, 32768)}`
      );
    }
  }
});

test("a file with a corrupt optional dimension is unreadable rather than mispriced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-badopt-"));
  const file = path.join(dir, "model.gguf");
  writeGguf(file, { ...GEMMA_SWA, keyLength: -500 });

  assert.equal(readGgufMetadata(file), null);
});

const HONEST_MACHINE = {
  totalMemBytes: 25769803776,
  modelFileBytes: 5405168384,
  availableMemBytes: 5292244992,
};

test("more attention heads than embedding dimensions cannot price a cell at zero", () => {
  // headDim is embeddingLength / headCount floored, so head_count 4096 against
  // embedding_length 2560 gives 0 — and `keyLength ?? headDim` keeps a literal 0,
  // because 0 is not nullish. Both sides of the cell then cost nothing and every
  // context looks free, up to the full trained 131072.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-gguf-headdim-"));

  for (const [name, spec] of [
    ["key_length absent", { ...GEMMA_SWA, headCount: 4096, keyLength: undefined }],
    [
      "key and value absent",
      { ...GEMMA_SWA, headCount: 4096, keyLength: undefined, valueLength: undefined },
    ],
  ]) {
    const file = path.join(dir, `${name.replace(/\W/g, "-")}.gguf`);
    writeGguf(file, spec);
    const meta = readGgufMetadata(file);
    assert.equal(meta, null, `${name}: a model with fewer dimensions than heads cannot exist`);
  }

  // Callers pass plain objects too, so the pricing must refuse them independently.
  const honest = resolveContextSize({ gguf: GEMMA_SWA, ...HONEST_MACHINE });
  for (const bogus of [
    { ...GEMMA_SWA, headDim: 0, keyLength: undefined },
    { ...GEMMA_SWA, headDim: 0, keyLength: undefined, valueLength: undefined },
    { ...GEMMA_SWA, headCount: 4096, keyLength: undefined, valueLength: undefined },
    // Only the key side falls to the floored zero; the value side keeps its own
    // key, so the cell is priced at exactly half and the context doubles.
    { ...GEMMA_SWA, headCount: 4096, keyLength: undefined },
    { ...GEMMA_SWA, headCount: 4096, valueLength: undefined },
    { ...GEMMA_SWA, embeddingLength: 4, headCount: 8 },
  ]) {
    const resolved = resolveContextSize({ gguf: bogus, ...HONEST_MACHINE });
    assert.ok(
      resolved.contextSize <= honest.contextSize,
      `a zero-priced cell bought ${resolved.contextSize} against an honest ${honest.contextSize}`
    );
  }
});

test("a model trained below the floor keeps its floor, not the unreadable-header default", () => {
  // The bail-out must not confuse "cannot be priced" with "trained small". An
  // honest 1024-context model priced at the 8192 fallback would be given 8x the
  // context it was trained for, with nothing costing it.
  const small = { ...GEMMA, contextLength: 1024 };

  const resolved = resolveContextSize({ gguf: small, ...HONEST_MACHINE });

  assert.equal(resolved.contextSize, 2048, "same as before this change");
  assert.notEqual(resolved.source, "fallback");
  assert.equal(resolved.trainedContext, 1024, "a priced model reports its geometry");
});

test("a non-finite trained context cannot hang the search", () => {
  for (const contextLength of [
    Infinity,
    -Infinity,
    NaN,
    1.5,
    // Past what GGUF's u32 context_length can hold. Left unbounded these drive
    // the search to spend the whole memory budget on a context the model cannot
    // use — 262144 on a roomy machine, against an honest 131072.
    Number.MAX_SAFE_INTEGER,
    1e308,
    0x100000000,
  ]) {
    // Both profiles matter. On the reported machine the memory budget hides the
    // bug; only a machine roomy enough to afford the inflated context exposes it.
    for (const machine of [
      HONEST_MACHINE,
      { totalMemBytes: 137438953472, modelFileBytes: 5405168384, availableMemBytes: 68719476736 },
    ]) {
      const honest = resolveContextSize({ gguf: GEMMA_SWA, ...machine });
      const started = Date.now();
      const resolved = resolveContextSize({ gguf: { ...GEMMA_SWA, contextLength }, ...machine });

      assert.ok(Date.now() - started < 1000, `${contextLength} took too long`);
      assert.ok(
        Number.isInteger(resolved.contextSize) && resolved.contextSize <= honest.contextSize,
        `${contextLength} resolved ${resolved.contextSize} against an honest ${honest.contextSize}`
      );
    }
  }
});

test("a context too large to price reads as unaffordable, not as free", () => {
  // kvCacheBytes is exported, so a caller can ask for any size. The arithmetic
  // overflows to Infinity there, and reporting that as zero would tell the
  // resolver's search the enormous context costs nothing.
  assert.equal(kvCacheBytes(GEMMA_SWA, 1e308), Number.POSITIVE_INFINITY);
  assert.ok(kvCacheBytes(GEMMA_SWA, 2 ** 40) > kvCacheBytes(GEMMA_SWA, 2 ** 20));
});

test("a fractional sliding-layer count cannot buy context", () => {
  const honest = resolveContextSize({ gguf: GEMMA_SWA, ...HONEST_MACHINE });

  for (const swaLayerCount of [41.5, 0.5, NaN]) {
    const resolved = resolveContextSize({ gguf: { ...GEMMA_SWA, swaLayerCount }, ...HONEST_MACHINE });
    assert.ok(
      resolved.contextSize <= honest.contextSize,
      `swaLayerCount ${swaLayerCount} bought ${resolved.contextSize} against ${honest.contextSize}`
    );
  }
});

test("an unpriceable geometry costs zero, never NaN", () => {
  // `kvCacheBytes` documents 0 as "cannot be priced" and the caller tests `> 0`.
  // NaN happens to fail that test too, but only by the polarity of the comparison.
  for (const gguf of [
    { ...GEMMA_SWA, blockCount: undefined },
    { ...GEMMA_SWA, headCountKv: undefined },
    {},
  ]) {
    assert.equal(kvCacheBytes(gguf, 8192), 0, JSON.stringify(gguf));
  }
});
