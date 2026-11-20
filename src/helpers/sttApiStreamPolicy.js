// Pure policy for the stt-api WebSocket client (Phase 5, D-05/D-06). ESM so it is
// importable by tests and loadable by main through require(esm). No electron, no
// logger, no network: the URL builder, the server-frame parser and the PCM16
// resampler live here so sttApiStreaming.js stays a thin socket adapter.

export const STT_API_STREAM_PATH = "/v1/transcriptions/stream";
export const STT_API_SEGMENTS_SUBPROTOCOL = "stt-segments";
export const STT_API_INPUT_RATE = 16000;
export const MAX_FRAME_TEXT_LENGTH = 100000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Turns the configured STT base URL (".../v1", "...", with or without a trailing
 * slash) into the stream endpoint. https becomes wss; http becomes ws only for a
 * loopback host, so a credential never crosses the network in clear text. Any
 * query or fragment on the base is dropped: the endpoint takes no query, which
 * keeps tokens out of URLs and logs.
 */
export function sttApiStreamUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || ""));
  } catch {
    throw new Error("stt-api stream: base URL is not a valid URL");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  let scheme;
  if (url.protocol === "https:") scheme = "wss:";
  else if (url.protocol === "http:" && loopback) scheme = "ws:";
  else throw new Error("stt-api stream: refusing a non-TLS URL for a non-loopback host");

  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3);
  return `${scheme}//${url.host}${path}${STT_API_STREAM_PATH}`;
}

const asText = (value) => (typeof value === "string" ? value : null);

/**
 * Parses one server frame into a typed object, or returns null for anything the
 * client should ignore: malformed JSON, unknown types, non-string text, or text
 * over MAX_FRAME_TEXT_LENGTH. The server is trusted for transport only, so every
 * field that reaches the UI is type-checked here.
 */
export function parseSttApiFrame(data) {
  let message;
  try {
    message = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;

  switch (message.type) {
    case "partial": {
      const text = asText(message.text);
      if (text === null || text.length > MAX_FRAME_TEXT_LENGTH) return null;
      return { type: "partial", text };
    }
    case "segment": {
      const text = asText(message.text);
      if (text === null || text.length > MAX_FRAME_TEXT_LENGTH) return null;
      if (!Number.isSafeInteger(message.index)) return null;
      return { type: "segment", index: message.index, text, final: message.final === true };
    }
    case "final": {
      const text = asText(message.text);
      if (text === null || text.length > MAX_FRAME_TEXT_LENGTH) return null;
      return { type: "final", text, truncated: message.truncated === true };
    }
    case "error": {
      const detail = message.error && typeof message.error === "object" ? message.error : {};
      return {
        type: "error",
        code: asText(detail.code) || "unknown",
        message: (asText(detail.message) || "stt-api stream error").slice(0, 500),
      };
    }
    default:
      return null;
  }
}

/**
 * Stateful PCM16LE mono resampler (linear interpolation). The fractional read
 * position is kept as an exact integer ratio, so feeding a stream in any chunking
 * yields the same samples as feeding it whole. An odd trailing byte and the
 * not-yet-consumed input samples are carried to the next call.
 */
export class Pcm16Resampler {
  constructor(fromRate, toRate = STT_API_INPUT_RATE) {
    if (!Number.isInteger(fromRate) || !Number.isInteger(toRate) || fromRate < 1 || toRate < 1) {
      throw new Error("Pcm16Resampler: rates must be positive integers");
    }
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.passthrough = fromRate === toRate;
    this.carry = new Int16Array(0);
    this.oddByte = null;
    // Read position in units of 1/toRate input samples, relative to carry[0].
    this.pos = 0;
  }

  /** @param {Buffer|Uint8Array} chunk PCM16LE at fromRate. @returns {Buffer} PCM16LE at toRate. */
  process(chunk) {
    let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.oddByte !== null) {
      bytes = Buffer.concat([Buffer.from([this.oddByte]), bytes]);
      this.oddByte = null;
    }
    if (bytes.length % 2 === 1) {
      this.oddByte = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (this.passthrough) return Buffer.from(bytes);

    const sampleCount = bytes.length / 2;
    const input = new Int16Array(this.carry.length + sampleCount);
    input.set(this.carry, 0);
    for (let i = 0; i < sampleCount; i++) {
      input[this.carry.length + i] = bytes.readInt16LE(i * 2);
    }

    const out = [];
    const { toRate, fromRate } = this;
    // A sample at index i needs input[i + 1] for interpolation.
    while (Math.floor(this.pos / toRate) + 1 < input.length) {
      const i = Math.floor(this.pos / toRate);
      const frac = (this.pos % toRate) / toRate;
      out.push(Math.round(input[i] + (input[i + 1] - input[i]) * frac));
      this.pos += fromRate;
    }

    const consumed = Math.min(Math.floor(this.pos / toRate), input.length);
    this.carry = input.slice(consumed);
    this.pos -= consumed * toRate;

    const result = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) result.writeInt16LE(out[i], i * 2);
    return result;
  }
}
