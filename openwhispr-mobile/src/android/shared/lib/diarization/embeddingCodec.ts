import { Buffer } from 'buffer';

export class InvalidEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEmbeddingError';
  }
}

export function validateEmbedding(values: number[], expectedDimension?: number): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new InvalidEmbeddingError('Embedding must contain at least one value');
  }
  if (expectedDimension !== undefined && values.length !== expectedDimension) {
    throw new InvalidEmbeddingError(
      `Embedding dimension mismatch: expected ${expectedDimension}, received ${values.length}`,
    );
  }
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      throw new InvalidEmbeddingError(`Embedding value at index ${index} must be finite`);
    }
  });
}

export function encodeEmbedding(values: number[]): Uint8Array {
  validateEmbedding(values);
  const bytes = new Uint8Array(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true);
  });
  return bytes;
}

export function decodeEmbedding(blob: Buffer | Uint8Array | ArrayBuffer): number[] {
  const buffer =
    blob instanceof ArrayBuffer
      ? Buffer.from(blob)
      : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);

  if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new InvalidEmbeddingError('Embedding blob must contain Float32 values');
  }

  const values: number[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += Float32Array.BYTES_PER_ELEMENT) {
    values.push(buffer.readFloatLE(offset));
  }
  validateEmbedding(values);
  return values;
}
