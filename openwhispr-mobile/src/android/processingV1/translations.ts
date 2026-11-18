import type { V1Key } from './strings';

// Missing keys fall back to English.
export const v1Translations: Record<string, Partial<Record<V1Key, string>>> = {};
