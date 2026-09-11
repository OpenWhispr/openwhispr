const test = require("node:test");
const assert = require("node:assert/strict");

const { readGgufMetadata } = require("../../src/helpers/ggufMetadata");
const { TYPE, buildGguf, bufferReader, LLAMA_3_2_3B_ENTRIES } = require("./harness/ggufFixtures");

const read = (entries, options) => readGgufMetadata(bufferReader(buildGguf(entries, options)));

test("reads the architecture fields that determine KV cost", async () => {
  const metadata = await read(LLAMA_3_2_3B_ENTRIES);

  assert.equal(metadata.architecture, "llama");
  assert.equal(metadata.blockCount, 28);
  assert.equal(metadata.headCountKv, 8);
  assert.equal(metadata.keyLength, 128);
  assert.equal(metadata.valueLength, 128);
  assert.equal(metadata.embeddingLength, 3072);
  assert.equal(metadata.headCount, 24);
  assert.equal(metadata.contextLength, 131072);
});

test("prefers the model's own context length over anything declared elsewhere", async () => {
  // The registry says 128000 for qwen2.5-7b, which is not what the GGUF says.
  // The GGUF is the file llama.cpp actually loads, so it wins.
  const metadata = await read([
    { key: "general.architecture", type: TYPE.STRING, value: "qwen2" },
    { key: "qwen2.block_count", type: TYPE.UINT32, value: 28 },
    { key: "qwen2.context_length", type: TYPE.UINT32, value: 131072 },
    { key: "qwen2.attention.head_count_kv", type: TYPE.UINT32, value: 4 },
    { key: "qwen2.attention.key_length", type: TYPE.UINT32, value: 128 },
    { key: "qwen2.attention.value_length", type: TYPE.UINT32, value: 128 },
  ]);

  assert.equal(metadata.contextLength, 131072);
});

test("reads a per-layer head_count_kv array", async () => {
  const metadata = await read([
    { key: "general.architecture", type: TYPE.STRING, value: "gemma3" },
    { key: "gemma3.block_count", type: TYPE.UINT32, value: 4 },
    {
      key: "gemma3.attention.head_count_kv",
      type: TYPE.ARRAY,
      elementType: TYPE.UINT32,
      values: [2, 8, 2, 2],
    },
    { key: "gemma3.attention.key_length", type: TYPE.UINT32, value: 256 },
    { key: "gemma3.attention.value_length", type: TYPE.UINT32, value: 256 },
  ]);

  assert.deepEqual(metadata.headCountKv, [2, 8, 2, 2]);
});

test("flags recurrent state, which costs memory the KV formula does not capture", async () => {
  const metadata = await read([
    { key: "general.architecture", type: TYPE.STRING, value: "qwen35" },
    { key: "qwen35.block_count", type: TYPE.UINT32, value: 33 },
    { key: "qwen35.attention.head_count_kv", type: TYPE.UINT32, value: 4 },
    { key: "qwen35.attention.key_length", type: TYPE.UINT32, value: 256 },
    { key: "qwen35.attention.value_length", type: TYPE.UINT32, value: 256 },
    { key: "qwen35.ssm.state_size", type: TYPE.UINT32, value: 128 },
  ]);

  assert.equal(metadata.hasRecurrentState, true);
});

test("walks past every scalar type without losing its place", async () => {
  // A real GGUF interleaves dozens of unrelated keys of every type before the
  // ones we want. Mis-sizing any of them desynchronises the whole parse.
  const metadata = await read([
    { key: "general.architecture", type: TYPE.STRING, value: "llama" },
    { key: "noise.u8", type: TYPE.UINT8, value: 7 },
    { key: "noise.i8", type: TYPE.INT8, value: 7 },
    { key: "noise.u16", type: TYPE.UINT16, value: 7 },
    { key: "noise.i16", type: TYPE.INT16, value: 7 },
    { key: "noise.u32", type: TYPE.UINT32, value: 7 },
    { key: "noise.i32", type: TYPE.INT32, value: 7 },
    { key: "noise.f32", type: TYPE.FLOAT32, value: 7.5 },
    { key: "noise.bool", type: TYPE.BOOL, value: true },
    { key: "noise.string", type: TYPE.STRING, value: "a longer value" },
    { key: "noise.u64", type: TYPE.UINT64, value: 7 },
    { key: "noise.i64", type: TYPE.INT64, value: 7 },
    { key: "noise.f64", type: TYPE.FLOAT64, value: 7.5 },
    ...LLAMA_3_2_3B_ENTRIES.slice(1),
  ]);

  assert.equal(metadata.blockCount, 28);
  assert.equal(metadata.headCountKv, 8);
});

test("skips the tokenizer arrays that dominate a real header", async () => {
  // tokenizer.ggml.tokens is a string array with 150k+ entries and accounts for
  // nearly all of a real 10 MiB metadata section. It must be stepped over, not
  // materialised.
  const tokens = Array.from({ length: 5000 }, (_, index) => `token_${index}`);
  const metadata = await read([
    { key: "general.architecture", type: TYPE.STRING, value: "llama" },
    { key: "tokenizer.ggml.tokens", type: TYPE.ARRAY, elementType: TYPE.STRING, values: tokens },
    {
      key: "tokenizer.ggml.scores",
      type: TYPE.ARRAY,
      elementType: TYPE.FLOAT32,
      values: tokens.map(() => 0),
    },
    ...LLAMA_3_2_3B_ENTRIES.slice(1),
  ]);

  assert.equal(metadata.blockCount, 28);
  assert.equal(metadata.headCountKv, 8);
});

test("returns null instead of throwing on anything malformed", async () => {
  // A null must route the caller to the historical 16384. Throwing here would
  // fail the user's dictation instead.
  const good = buildGguf(LLAMA_3_2_3B_ENTRIES);

  const cases = {
    "bad magic": bufferReader(buildGguf(LLAMA_3_2_3B_ENTRIES, { magic: 0xdeadbeef })),
    "version 1": bufferReader(buildGguf(LLAMA_3_2_3B_ENTRIES, { version: 1 })),
    "truncated mid-header": bufferReader(good.subarray(0, 60)),
    "empty file": bufferReader(Buffer.alloc(0)),
    "header only": bufferReader(good.subarray(0, 8)),
    "implausible kv count": bufferReader(buildGguf(LLAMA_3_2_3B_ENTRIES, { kvCount: 99999 })),
    "unknown value type": bufferReader(
      buildGguf([{ key: "general.architecture", type: TYPE.STRING, value: "llama" }]).fill(
        0x7f,
        // clobber the first value's type tag
        4 + 4 + 8 + 8 + 8 + "general.architecture".length,
        4 + 4 + 8 + 8 + 8 + "general.architecture".length + 4
      )
    ),
  };

  for (const [label, reader] of Object.entries(cases)) {
    const metadata = await readGgufMetadata(reader);
    assert.equal(metadata, null, `${label} should read as null`);
  }
});

test("returns null when a read fails outright", async () => {
  const metadata = await readGgufMetadata({
    size: 1024,
    read: async () => {
      throw new Error("EIO");
    },
  });

  assert.equal(metadata, null);
});

test("returns null when the architecture keys are simply absent", async () => {
  const metadata = await read([
    { key: "general.name", type: TYPE.STRING, value: "some model" },
    { key: "general.file_type", type: TYPE.UINT32, value: 15 },
  ]);

  assert.equal(metadata, null);
});
