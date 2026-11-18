import i18n, { type TOptions } from 'i18next';
import { Platform } from 'react-native';

/** Read the current Android language for alerts outside React components. */
export function androidCopy(key: string, fallback: string, options?: TOptions): string {
  if (Platform.OS !== 'android' || !i18n.isInitialized) return fallback;
  return i18n.t(key, { ...options, ns: 'android', defaultValue: fallback }) || fallback;
}
