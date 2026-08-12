/**
 * Minimal GGUF header reader.
 *
 * We need three things a model file knows and nothing else does reliably: the
 * context it was trained for, and the geometry that decides how many bytes of
 * KV cache each token of context costs. The app's own model registry cannot be
 * trusted for this — it claims 262144 for a model whose header says 131072.
 *
 * Only the metadata block at the head of the file is read; tensor data is never
 * touched.
 */
const fs = require("fs");

const HEADER_BYTES = 4 * 1024 * 1024;
const KV_BYTES_PER_ELEMENT = 2; // llama.cpp defaults to an f16 KV cache

// GGUF value type ids → byte width. Strings (8) and arrays (9) are length-prefixed.
const SCALAR_WIDTHS = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function createReader(buf) {
  let offset = 0;
  const remaining = () => buf.length - offset;

  return {
    get offset() {
      return offset;
    },
    u32() {
      if (remaining() < 4) throw new RangeError("truncated");
      const value = buf.readUInt32LE(offset);
      offset += 4;
      return value;
    },
    u64() {
      if (remaining() < 8) throw new RangeError("truncated");
      const value = buf.readBigUInt64LE(offset);
      offset += 8;
      return value;
    },
    str() {
      const len = Number(this.u64());
      if (len < 0 || remaining() < len) throw new RangeError("truncated");
      const value = buf.toString("utf8", offset, offset + len);
      offset += len;
      return value;
    },
    skipValue(type) {
      if (type === 8) {
        this.str();
        return;
      }
      if (type === 9) {
        const elementType = this.u32();
        const count = Number(this.u64());
        for (let i = 0; i < count; i += 1) this.skipValue(elementType);
        return;
      }
      const width = SCALAR_WIDTHS[type];
      if (width === undefined) throw new RangeError(`unknown gguf value type ${type}`);
      if (remaining() < width) throw new RangeError("truncated");
      offset += width;
    },
    readScalar(type) {
      const start = offset;
      this.skipValue(type);
      if (type === 4) return buf.readUInt32LE(start);
      if (type === 5) return buf.readInt32LE(start);
      if (type === 10) return Number(buf.readBigUInt64LE(start));
      if (type === 11) return Number(buf.readBigInt64LE(start));
      return null;
    },
  };
}

/**
 * @returns {{contextLength:number, blockCount:number, headCount:number,
 *   headCountKv:number, embeddingLength:number, headDim:number}|null}
 *   null when the file is missing, not a GGUF, or too damaged to parse.
 */
function readGgufMetadata(modelPath) {
  let fd;
  try {
    fd = fs.openSync(modelPath, "r");
    const buf = Buffer.alloc(HEADER_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    const header = buf.subarray(0, bytesRead);

    if (header.length < 24 || header.toString("ascii", 0, 4) !== "GGUF") return null;

    const reader = createReader(header);
    reader.u32(); // magic
    reader.u32(); // version
    reader.u64(); // tensor count
    const kvCount = Number(reader.u64());

    const found = {};
    const WANTED = {
      context_length: "contextLength",
      block_count: "blockCount",
      embedding_length: "embeddingLength",
      "attention.head_count": "headCount",
      "attention.head_count_kv": "headCountKv",
    };

    for (let i = 0; i < kvCount; i += 1) {
      const key = reader.str();
      const type = reader.u32();
      // Keys are architecture-prefixed, e.g. "gemma4.context_length".
      const suffix = Object.keys(WANTED).find((name) => key.endsWith(`.${name}`));
      if (suffix) {
        const value = reader.readScalar(type);
        if (typeof value === "number") found[WANTED[suffix]] = value;
      } else {
        reader.skipValue(type);
      }
      if (Object.keys(found).length === Object.keys(WANTED).length) break;
    }

    if (!found.contextLength || !found.blockCount || !found.headCountKv) return null;
    if (!found.headCount || !found.embeddingLength) return null;

    return { ...found, headDim: Math.floor(found.embeddingLength / found.headCount) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing useful to do
      }
    }
  }
}

/** Bytes of KV cache one token of context costs, for this model's geometry. */
function kvBytesPerToken(gguf) {
  const headDim = gguf.headDim ?? Math.floor(gguf.embeddingLength / gguf.headCount);
  const kvDim = gguf.headCountKv * headDim;
  return gguf.blockCount * 2 * kvDim * KV_BYTES_PER_ELEMENT;
}

module.exports = { readGgufMetadata, kvBytesPerToken };
