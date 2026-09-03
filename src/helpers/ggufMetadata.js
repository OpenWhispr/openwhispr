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

const isPositiveInt = (value) => Number.isInteger(value) && value > 0;

// Every geometry field that participates in the arithmetic. All are read as
// signed int32s, so any of them can arrive negative from a corrupt file — and a
// negative dimension makes each token look cheaper, which buys a LARGER context
// than an honest header would. Pricing refuses to guess at such a model at all.
const DIMENSION_FIELDS = [
  "blockCount",
  "headCount",
  "headCountKv",
  "embeddingLength",
  "headDim",
  "keyLength",
  "valueLength",
  "keyLengthSwa",
  "valueLengthSwa",
];

const isWholeCount = (value) => Number.isInteger(value) && value >= 0;

// GGUF stores context_length as a 32-bit unsigned int, so anything past this is
// not a large model, it is a corrupt field. Left unbounded, a header claiming a
// context of 9e15 drives the resolver to allocate whatever the memory budget
// happens to allow rather than what the model can actually use.
const MAX_TRAINED_CONTEXT = 0xffffffff;

const hasSaneGeometry = (gguf) => {
  // Zero is the honest way to say "no sliding window" and "no sliding layers", so
  // these two may be absent or zero — but a fractional count would shrink the
  // cache and buy context, so both must still be whole.
  if (gguf.slidingWindow !== undefined && !isWholeCount(gguf.slidingWindow)) return false;
  if (gguf.swaLayerCount !== undefined && !isWholeCount(gguf.swaLayerCount)) return false;
  if (gguf.contextLength !== undefined && gguf.contextLength > MAX_TRAINED_CONTEXT) return false;

  if (!DIMENSION_FIELDS.every((f) => gguf[f] === undefined || isPositiveInt(gguf[f]))) {
    return false;
  }

  // The head dimension is usually derived rather than stored, so validating the
  // stored field is not enough: embedding_length 2560 over head_count 4096 floors
  // to zero, and `keyLength || headDim` then prices that side of the cell at
  // nothing whenever attention.key_length is absent.
  if (gguf.headDim === undefined && gguf.embeddingLength !== undefined && gguf.headCount) {
    return Math.floor(gguf.embeddingLength / gguf.headCount) >= 1;
  }

  return true;
};

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
    /** Counts the `true` entries of a bool array, leaving the cursor past it. */
    countTrueInBoolArray() {
      const elementType = this.u32();
      const count = Number(this.u64());
      if (elementType !== 7) {
        for (let i = 0; i < count; i += 1) this.skipValue(elementType);
        return null;
      }
      if (remaining() < count) throw new RangeError("truncated");
      let trueCount = 0;
      for (let i = 0; i < count; i += 1) {
        if (buf.readUInt8(offset + i) !== 0) trueCount += 1;
      }
      offset += count;
      return trueCount;
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
    const REQUIRED = {
      context_length: "contextLength",
      block_count: "blockCount",
      embedding_length: "embeddingLength",
      "attention.head_count": "headCount",
      "attention.head_count_kv": "headCountKv",
    };
    // Absent on most architectures. A model that carries them prices its KV cache
    // very differently — see kvCacheBytes.
    const OPTIONAL = {
      "attention.key_length": "keyLength",
      "attention.value_length": "valueLength",
      "attention.key_length_swa": "keyLengthSwa",
      "attention.value_length_swa": "valueLengthSwa",
      "attention.sliding_window": "slidingWindow",
    };
    const WANTED = { ...REQUIRED, ...OPTIONAL };

    for (let i = 0; i < kvCount; i += 1) {
      const key = reader.str();
      const type = reader.u32();

      // The tokenizer block is megabytes of arrays and holds nothing we want.
      // Every architecture-prefixed geometry key precedes it, so stopping here
      // keeps the scan inside HEADER_BYTES. Without this, a model missing any one
      // optional key would read on past the buffer, throw, and be reported as
      // unreadable — which it is not.
      if (key.startsWith("tokenizer.")) break;

      if (key.endsWith(".attention.sliding_window_pattern") && type === 9) {
        const swaLayerCount = reader.countTrueInBoolArray();
        if (swaLayerCount !== null) found.swaLayerCount = swaLayerCount;
        continue;
      }

      // Keys are architecture-prefixed, e.g. "gemma4.context_length".
      const suffix = Object.keys(WANTED).find((name) => key.endsWith(`.${name}`));
      if (suffix) {
        const value = reader.readScalar(type);
        if (typeof value === "number") found[WANTED[suffix]] = value;
      } else {
        reader.skipValue(type);
      }
    }

    // Positive, not merely truthy: these are read as signed int32s, and a negative
    // context length rounds to NaN and reaches llama-server as `--ctx-size NaN`.
    if (!isPositiveInt(found.contextLength) || found.contextLength > MAX_TRAINED_CONTEXT) {
      return null;
    }

    if (!hasSaneGeometry(found)) return null;

    // Fewer embedding dimensions than attention heads describes a model that
    // cannot exist, and floors to a head dimension of zero.
    const headDim = Math.floor(found.embeddingLength / found.headCount);
    if (!isPositiveInt(headDim)) return null;

    return { swaLayerCount: 0, ...found, headDim };
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

// llama-server picks n_parallel automatically; darwin-arm64 chose 4. The sliding
// cache is sized from the window and the batch, not from n_ctx, so an error here
// costs a fixed number of megabytes and can never run away with the context.
const SWA_SEQ_ALLOWANCE = 4;
const SWA_BATCH_ALLOWANCE = 2048;

const bytesPerCell = (gguf, keyDim, valueDim) =>
  gguf.headCountKv * (keyDim + valueDim) * KV_BYTES_PER_ELEMENT;

/**
 * Splits the layers into the ones whose cache grows with n_ctx and the ones
 * pinned to the sliding window.
 *
 * A pattern without a positive window is treated as no split at all. Pricing
 * layers as sliding when they really grow is the one error that would under-count
 * the cache, and under-counting is what puts the machine into swap.
 */
function kvGeometry(gguf) {
  // `??` keeps a literal 0, and headDim is a floored division: embedding_length
  // 2560 over head_count 4096 is 0, which would price both sides of every cell at
  // nothing and make the full trained context look free.
  const headDim = gguf.headDim ?? Math.floor(gguf.embeddingLength / gguf.headCount);
  const keyLength = gguf.keyLength || headDim;
  const valueLength = gguf.valueLength || keyLength;

  const slidingWindow = gguf.slidingWindow ?? 0;
  // A pattern that disagrees with block_count describes a model that cannot exist,
  // so nothing else in it can be trusted either — including the claim that these
  // layers slide. Clamping would merely reprice every layer as fixed-size, which
  // says the cache never grows and makes the full trained context look free: the
  // ~14GB allocation that stalled a machine in August. Distrusting the split
  // outright prices every layer as growing, which fails towards a small context.
  const claimedSwaLayers = gguf.swaLayerCount ?? 0;
  const trustworthy =
    slidingWindow > 0 && claimedSwaLayers >= 0 && claimedSwaLayers <= gguf.blockCount;
  const swaLayers = trustworthy ? claimedSwaLayers : 0;

  return {
    slidingWindow,
    swaLayers,
    globalLayers: gguf.blockCount - swaLayers,
    globalBytesPerCell: bytesPerCell(gguf, keyLength, valueLength),
    swaBytesPerCell: bytesPerCell(
      gguf,
      gguf.keyLengthSwa || keyLength,
      gguf.valueLengthSwa || valueLength
    ),
  };
}

/** Bytes of KV cache each token of context costs — the part that grows. */
function kvBytesPerToken(gguf) {
  const { globalLayers, globalBytesPerCell } = kvGeometry(gguf);
  return globalLayers * globalBytesPerCell;
}

/**
 * Total KV cache llama.cpp will allocate for this model at this context.
 *
 * Not `kvBytesPerToken * contextSize`: on a sliding-window model most layers hold
 * a cache fixed at the window size however large n_ctx grows. Measured against
 * google_gemma-4-E4B-it-Q4_K_M, whose 35 sliding layers cost a flat 100 MiB at
 * every context from 4096 to 131072 while its 7 global layers scale linearly.
 * Treating all 42 as growing over-stated the cache 6.3x and collapsed the
 * resolved context to the floor.
 */
function kvCacheBytes(gguf, contextSize) {
  // Zero reads as "cannot be priced" to resolveContextSize, which then treats the
  // model as it treats an unreadable header: a small fixed context.
  if (!hasSaneGeometry(gguf)) return 0;

  const { slidingWindow, swaLayers, globalLayers, globalBytesPerCell, swaBytesPerCell } =
    kvGeometry(gguf);

  const swaCells = Math.min(
    contextSize,
    slidingWindow * SWA_SEQ_ALLOWANCE + SWA_BATCH_ALLOWANCE
  );

  const total =
    globalLayers * globalBytesPerCell * contextSize + swaLayers * swaBytesPerCell * swaCells;

  if (Number.isFinite(total)) return total >= 0 ? total : 0;

  // Two very different non-finite answers. NaN means the geometry could not be
  // priced at all, which zero reports to the caller. Infinity means it was priced
  // and is enormous — a context so large the arithmetic overflowed — and that must
  // read as unaffordable, never as zero: the resolver's search asks "does this
  // cost more than the budget", and a zero there would accept the overflowing
  // context as free.
  return Number.isNaN(total) ? 0 : Number.POSITIVE_INFINITY;
}

module.exports = { readGgufMetadata, kvBytesPerToken, kvCacheBytes };
