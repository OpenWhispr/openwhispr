/**
 * Builds GGUF headers in memory so the metadata reader can be tested without
 * downloading a multi-gigabyte model. Only the header is produced: the reader
 * never looks at tensor data.
 */
const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian

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

const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return b;
};

const u64 = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
};

const ggufString = (value) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
};

function encodeScalar(type, value) {
  switch (type) {
    case TYPE.UINT8:
    case TYPE.INT8:
      return Buffer.from([value & 0xff]);
    case TYPE.UINT16:
    case TYPE.INT16: {
      const b = Buffer.alloc(2);
      b.writeUInt16LE(value);
      return b;
    }
    case TYPE.UINT32:
    case TYPE.INT32:
      return u32(value);
    case TYPE.FLOAT32: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(value);
      return b;
    }
    case TYPE.BOOL:
      return Buffer.from([value ? 1 : 0]);
    case TYPE.STRING:
      return ggufString(value);
    case TYPE.UINT64:
    case TYPE.INT64:
      return u64(value);
    case TYPE.FLOAT64: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(value);
      return b;
    }
    default:
      throw new Error(`unsupported scalar type ${type}`);
  }
}

function encodeValue(entry) {
  if (entry.type === TYPE.ARRAY) {
    const elements = entry.values.map((value) => encodeScalar(entry.elementType, value));
    return Buffer.concat([u32(entry.elementType), u64(entry.values.length), ...elements]);
  }
  return encodeScalar(entry.type, entry.value);
}

/**
 * @param entries {Array<{key: string, type: number, value?: any,
 *                        elementType?: number, values?: any[]}>}
 */
function buildGguf(entries, { version = 3, magic = GGUF_MAGIC, kvCount = null } = {}) {
  const parts = [u32(magic), u32(version), u64(0) /* tensor_count */];
  parts.push(u64(kvCount === null ? entries.length : kvCount));
  for (const entry of entries) {
    parts.push(ggufString(entry.key), u32(entry.type), encodeValue(entry));
  }
  return Buffer.concat(parts);
}

/** A reader over an in-memory buffer, matching the shape readGgufMetadata expects. */
function bufferReader(buffer) {
  return {
    size: buffer.length,
    read: async (offset, length) => buffer.subarray(offset, offset + length),
  };
}

// The #1203 model, as its GGUF declares itself.
const LLAMA_3_2_3B_ENTRIES = [
  { key: "general.architecture", type: TYPE.STRING, value: "llama" },
  { key: "llama.block_count", type: TYPE.UINT32, value: 28 },
  { key: "llama.context_length", type: TYPE.UINT32, value: 131072 },
  { key: "llama.embedding_length", type: TYPE.UINT32, value: 3072 },
  { key: "llama.attention.head_count", type: TYPE.UINT32, value: 24 },
  { key: "llama.attention.head_count_kv", type: TYPE.UINT32, value: 8 },
  { key: "llama.attention.key_length", type: TYPE.UINT32, value: 128 },
  { key: "llama.attention.value_length", type: TYPE.UINT32, value: 128 },
];

module.exports = { TYPE, buildGguf, bufferReader, LLAMA_3_2_3B_ENTRIES };
