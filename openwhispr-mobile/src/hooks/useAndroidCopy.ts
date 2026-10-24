import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TOptions } from 'i18next';

/** Localize shared Android surfaces while retaining their existing iOS copy. */
export function useAndroidCopy() {
  const { t, i18n } = useTranslation('android');
  const copy = useCallback(
    (key: string, iosText: string, options?: TOptions): string =>
      Platform.OS === 'android' ? t(key, { ...options, defaultValue: iosText }) : iosText,
    [t],
  );
  return { copy, language: i18n?.resolvedLanguage || i18n?.language || 'en' };
}
