import * as Crypto from 'expo-crypto';

export function randomUUID(): string {
  const uuid = Crypto.randomUUID();
  if (!uuid) {
    throw new Error('Secure UUID generation is unavailable');
  }
  return uuid;
}
