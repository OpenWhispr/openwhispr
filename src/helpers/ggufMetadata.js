/**
 * Minimal GGUF metadata reader.
 *
 * Only the header is parsed — the magic, version, counts, and the metadata
 * key/value section. Tensor descriptors and tensor data are never touched, so
 * this reads a few megabytes off the front of a multi-gigabyte file.
 *
 * It exists to answer one question: how many bytes of KV cache does one token
 * of context cost for this model? That number varies ~12x across the bundled
 * registry and is anti-correlated with file size, so it cannot be guessed from
 * anything the model registry records (#2142). The GGUF is also the file
 * llama.cpp actually loads, which makes it the honest source for the trained
 * context length as well.
 *
 * Every failure returns null. Callers must read null as "fall back to the
 * historical context size", never as "assume this model is cheap".
 */
const fs = require("fs");

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian
const MIN_SUPPORTED_VERSION = 2; // v1 used 32-bit lengths; no bundled model uses it
const MAX_SUPPORTED_VERSION = 3;

const READ_CHUNK_BYTES = 1024 * 1024;
// A real header is ~10 MiB, dominated by the tokenizer token array. These are
// guards against a corrupt file steering us into an unbounded allocation.
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_KV_COUNT = 4096;
const MAX_STRING_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURED_ARRAY_LENGTH = 1024;

const TYPE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
};

const SCALAR_BYTES = {
  [TYPE.UINT8]: 1,
  [TYPE.INT8]: 1,
  [TYPE.UINT16]: 2,
  [TYPE.INT16]: 2,
  [TYPE.UINT32]: 4,
  [TYPE.INT32]: 4,
  [TYPE.FLOAT32]: 4,
  [TYPE.BOOL]: 1,
  [TYPE.UINT64]: 8,
  [TYPE.INT64]: 8,
  [TYPE.FLOAT64]: 8,
};

// Suffixes whose values decide KV cost. Matched against the architecture
// prefix the file declares, so this works for any arch without an allow-list.
const WANTED_SUFFIXES = [
  ".block_count",
  ".context_length",
  ".embedding_length",
  ".attention.head_count",
  ".attention.head_count_kv",
  ".attention.key_length",
  ".attention.value_length",
];

/** Forward-only cursor over the front of the file, buffered in chunks. */
class HeaderCursor {
  constructor(source) {
    this.source = source;
    this.chunk = Buffer.alloc(0);
    this.chunkStart = 0;
    this.position = 0;
  }

  async ensure(length) {
    if (this.position + length > MAX_METADATA_BYTES) {
      throw new Error("gguf metadata section is implausibly large");
    }
    const withinChunk =
      this.position >= this.chunkStart &&
      this.position + length <= this.chunkStart + this.chunk.length;
    if (withinChunk) return;

    const buffer = await this.source.read(this.position, Math.max(length, READ_CHUNK_BYTES));
    if (!buffer || buffer.length < length) throw new Error("unexpected end of gguf header");
    this.chunk = buffer;
    this.chunkStart = this.position;
  }

  async take(length) {
    await this.ensure(length);
    const start = this.position - this.chunkStart;
    this.position += length;
    return this.chunk.subarray(start, start + length);
  }

  /** Advances without reading, so huge arrays cost nothing. */
  skip(length) {
    if (length < 0) throw new Error("negative skip in gguf header");
    this.position += length;
  }

  async readUint32() {
    return (await this.take(4)).readUInt32LE(0);
  }

  async readUint64() {
    const value = (await this.take(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("gguf length out of range");
    return Number(value);
  }

  async readString() {
    const length = await this.readUint64();
    if (length > MAX_STRING_BYTES) throw new Error("gguf string is implausibly long");
    return (await this.take(length)).toString("utf8");
  }

  async skipString() {
    const length = await this.readUint64();
    if (length > MAX_STRING_BYTES) throw new Error("gguf string is implausibly long");
    this.skip(length);
  }

  async readScalar(type) {
    const buffer = await this.take(SCALAR_BYTES[type]);
    switch (type) {
      case TYPE.UINT8:
        return buffer.readUInt8(0);
      case TYPE.INT8:
        return buffer.readInt8(0);
      case TYPE.UINT16:
        return buffer.readUInt16LE(0);
      case TYPE.INT16:
        return buffer.readInt16LE(0);
      case TYPE.UINT32:
        return buffer.readUInt32LE(0);
      case TYPE.INT32:
        return buffer.readInt32LE(0);
      case TYPE.FLOAT32:
        return buffer.readFloatLE(0);
      case TYPE.BOOL:
        return buffer.readUInt8(0) !== 0;
      case TYPE.UINT64:
        return Number(buffer.readBigUInt64LE(0));
      case TYPE.INT64:
        return Number(buffer.readBigInt64LE(0));
      case TYPE.FLOAT64:
        return buffer.readDoubleLE(0);
      default:
        throw new Error(`unsupported gguf scalar type ${type}`);
    }
  }
}

async function readArray(cursor, capture) {
  const elementType = await cursor.readUint32();
  const length = await cursor.readUint64();

  if (elementType === TYPE.STRING) {
    // Each element carries its own length prefix, so it must be walked rather
    // than skipped wholesale. This is tokenizer.ggml.tokens, ~150k entries.
    for (let index = 0; index < length; index += 1) await cursor.skipString();
    return null;
  }

  const elementBytes = SCALAR_BYTES[elementType];
  if (elementBytes === undefined) throw new Error(`unsupported gguf array type ${elementType}`);

  if (!capture || length > MAX_CAPTURED_ARRAY_LENGTH) {
    cursor.skip(length * elementBytes);
    return null;
  }

  const values = [];
  for (let index = 0; index < length; index += 1) values.push(await cursor.readScalar(elementType));
  return values;
}

async function readValue(cursor, type, capture) {
  if (type === TYPE.STRING) {
    if (capture) return cursor.readString();
    await cursor.skipString();
    return null;
  }
  if (type === TYPE.ARRAY) return readArray(cursor, capture);

  const bytes = SCALAR_BYTES[type];
  if (bytes === undefined) throw new Error(`unsupported gguf value type ${type}`);
  if (capture) return cursor.readScalar(type);
  cursor.skip(bytes);
  return null;
}

function isWantedKey(key) {
  if (key === "general.architecture") return true;
  return WANTED_SUFFIXES.some((suffix) => key.endsWith(suffix));
}

function pick(entries, architecture, suffix) {
  return entries.get(`${architecture}${suffix}`);
}

/**
 * @param source {{ read: (offset: number, length: number) => Promise<Buffer>, size?: number }}
 * @returns the architecture fields needed to price the KV cache, or null.
 */
async function readGgufMetadata(source) {
  try {
    const cursor = new HeaderCursor(source);

    if ((await cursor.readUint32()) !== GGUF_MAGIC) return null;
    const version = await cursor.readUint32();
    if (version < MIN_SUPPORTED_VERSION || version > MAX_SUPPORTED_VERSION) return null;

    await cursor.readUint64(); // tensor_count, unused
    const kvCount = await cursor.readUint64();
    if (kvCount > MAX_KV_COUNT) return null;

    const entries = new Map();
    let hasRecurrentState = false;

    for (let index = 0; index < kvCount; index += 1) {
      const key = await cursor.readString();
      const type = await cursor.readUint32();
      if (key.includes(".ssm.")) hasRecurrentState = true;

      const value = await readValue(cursor, type, isWantedKey(key));
      if (value !== null) entries.set(key, value);
    }

    const architecture = entries.get("general.architecture");
    if (typeof architecture !== "string" || architecture.length === 0) return null;

    return {
      architecture,
      blockCount: pick(entries, architecture, ".block_count"),
      contextLength: pick(entries, architecture, ".context_length"),
      embeddingLength: pick(entries, architecture, ".embedding_length"),
      headCount: pick(entries, architecture, ".attention.head_count"),
      headCountKv: pick(entries, architecture, ".attention.head_count_kv"),
      keyLength: pick(entries, architecture, ".attention.key_length"),
      valueLength: pick(entries, architecture, ".attention.value_length"),
      hasRecurrentState,
    };
  } catch {
    return null;
  }
}

/** Convenience wrapper over a file on disk. */
async function readGgufMetadataFromFile(filePath) {
  let handle = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size } = await handle.stat();
    const file = handle;
    return await readGgufMetadata({
      size,
      read: async (offset, length) => {
        const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
        if (buffer.length === 0) return buffer;
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        return buffer.subarray(0, bytesRead);
      },
    });
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = { readGgufMetadata, readGgufMetadataFromFile };
