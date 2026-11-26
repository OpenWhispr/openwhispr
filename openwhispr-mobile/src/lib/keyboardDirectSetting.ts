import { Platform } from 'react-native';
import type { UserConfig } from '@/types';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

/**
 * The keyboard records on its own from iOS 26, with a native build that can share the session
 * with it (an OTA update can land on an older build that can't).
 */
export function keyboardDirectDictationSupported(): boolean {
  return (
    Platform.OS === 'ios' &&
    Number.parseInt(String(Platform.Version), 10) >= 26 &&
    AppGroupStorage.supportsKeyboardDirectDictation
  );
}

/**
 * On unless the user turned it off. Off where the keyboard can't record, so no session or
 * snapshot is shared with a keyboard that would never use it.
 */
export function keyboardDirectDictationEnabled(config: UserConfig | null): boolean {
  return keyboardDirectDictationSupported() && (config?.keyboardDirectDictation ?? true);
}
