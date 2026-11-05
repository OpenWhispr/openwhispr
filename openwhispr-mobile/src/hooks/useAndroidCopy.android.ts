import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TOptions } from 'i18next';

/** Localize Android surfaces using the current app language. */
export function useAndroidCopy() {
  const { t, i18n } = useTranslation('android');
  const copy = useCallback(
    (key: string, iosText: string, options?: TOptions): string =>
      t(key, { ...options, defaultValue: iosText }),
    [t],
  );
  return { copy, language: i18n?.resolvedLanguage || i18n?.language || 'en' };
}
