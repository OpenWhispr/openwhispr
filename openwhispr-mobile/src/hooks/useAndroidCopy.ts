import { useCallback } from 'react';
import type { TOptions } from 'i18next';

/** Retain shared surfaces' fallback copy without loading Android localization. */
export function useAndroidCopy() {
  const copy = useCallback(
    (_key: string, iosText: string, _options?: TOptions): string => iosText,
    [],
  );
  return { copy, language: 'en' };
}
