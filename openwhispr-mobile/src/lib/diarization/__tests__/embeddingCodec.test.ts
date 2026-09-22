import { Buffer } from 'buffer';
import {
  decodeEmbedding,
  encodeEmbedding,
  InvalidEmbeddingError,
  validateEmbedding,
} from '../embeddingCodec';

describe('embeddingCodec', () => {
  it('round-trips a float vector as little-endian Float32', () => {
    const values = [0.1, -1.25, Math.PI, 42];
    const encoded = encodeEmbedding(values);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(encoded)).toBe(false);
    expect(encoded.byteLength).toBe(values.length * Float32Array.BYTES_PER_ELEMENT);
    expect(
      new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength).getFloat32(0, true),
    ).toBeCloseTo(values[0], 6);

    const decoded = decodeEmbedding(encoded);
    decoded.forEach((value, index) => {
      expect(value).toBeCloseTo(values[index], 6);
    });
  });

  it('rejects empty, NaN, Infinity, and dimension mismatches', () => {
    expect(() => validateEmbedding([])).toThrow(InvalidEmbeddingError);
    expect(() => validateEmbedding([Number.NaN])).toThrow(InvalidEmbeddingError);
    expect(() => validateEmbedding([Number.POSITIVE_INFINITY])).toThrow(InvalidEmbeddingError);
    expect(() => validateEmbedding([1, 2], 3)).toThrow(InvalidEmbeddingError);
  });
});
