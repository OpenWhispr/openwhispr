import * as Crypto from 'expo-crypto';

export function randomUUID(): string {
  const uuid = Crypto.randomUUID();
  if (!uuid) {
    throw new Error('Secure UUID generation is unavailable');
  }
  return uuid;
}

/**
 * The same RFC 9562 version 8 UUID for the same key, from its SHA-256, the way
 * the API derives the ids of its own facts.
 */
export async function uuidFromKey(key: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
  // RFC 9562 variant bits 10xx, the API's `(n & 0x3) | 0x8`.
  const variant = (8 + (parseInt(hex[16], 16) % 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
