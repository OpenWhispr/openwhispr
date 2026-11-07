import { useConfigStore } from '@/store/useConfigStore';
import {
  normalizeKeyboardAutocorrectionLanguages,
  type KeyboardAutocorrectionLanguage,
} from '@/lib/keyboardAutocorrection';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// Default on: the keyboard also treats a missing key (fresh install, no Full Access) as on.
export function isKeyboardAutocorrectionEnabled(): boolean {
  return useConfigStore.getState().config?.keyboardAutocorrectionEnabled ?? true;
}

export function keyboardAutocorrectionLanguages(): KeyboardAutocorrectionLanguage[] {
  return normalizeKeyboardAutocorrectionLanguages(
    useConfigStore.getState().config?.keyboardAutocorrectionLanguages,
  );
}

function writeLanguages(languages: readonly string[]): void {
  // "de,en": the keyboard parses the same comma-separated codes.
  AppGroupStorage.setItem(
    APP_GROUP_KEYS.KEYBOARD_AUTOCORRECTION_LANGUAGES,
    normalizeKeyboardAutocorrectionLanguages(languages).join(','),
  );
}

function writeAppGroupAutocorrection(): void {
  AppGroupStorage.setItem(
    APP_GROUP_KEYS.KEYBOARD_AUTOCORRECTION_ENABLED,
    isKeyboardAutocorrectionEnabled() ? '1' : '0',
  );
  writeLanguages(keyboardAutocorrectionLanguages());
}

// Settings controls: write the App Group key first so the keyboard follows at once, without
// waiting on async config persistence.
export function setKeyboardAutocorrectionEnabled(enabled: boolean): void {
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_AUTOCORRECTION_ENABLED, enabled ? '1' : '0');
  useConfigStore
    .getState()
    .updateConfig({ keyboardAutocorrectionEnabled: enabled })
    .catch(() => {});
}

export function setKeyboardAutocorrectionLanguages(languages: readonly string[]): void {
  const normalized = normalizeKeyboardAutocorrectionLanguages(languages);
  writeLanguages(normalized);
  useConfigStore
    .getState()
    .updateConfig({ keyboardAutocorrectionLanguages: normalized })
    .catch(() => {});
}

// Config is the source of truth (only the app writes these keys); mirror it out now and on
// every config change.
export function startKeyboardAutocorrectionSync(): () => void {
  writeAppGroupAutocorrection();
  return useConfigStore.subscribe(writeAppGroupAutocorrection);
}
