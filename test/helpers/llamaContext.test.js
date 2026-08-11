const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readGgufMetadata, kvBytesPerToken } = require("../../src/helpers/ggufMetadata");
const { resolveContextSize } = require("../../src/helpers/llamaContext");

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

function writeGguf(filePath, { contextLength, blockCount, headCountKv, headCount, embeddingLength }) {
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
  const kvU32 = (key, value) => Buffer.concat([str(key), u32(4), u32(value)]);

  const entries = [
    kvU32("test.context_length", contextLength),
    kvU32("test.block_count", blockCount),
    kvU32("test.attention.head_count_kv", headCountKv),
    kvU32("test.attention.head_count", headCount),
    kvU32("test.embedding_length", embeddingLength),
  ];

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
