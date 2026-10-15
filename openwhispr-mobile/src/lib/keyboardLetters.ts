import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// The keyboard opens on numbers and punctuation unless Letter keys is on. It is a
// per-device layout choice, so it lives only in the App Group the keyboard reads,
// never in the synced config.
export function areKeyboardLettersEnabled(): boolean {
  return AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_LETTERS_ENABLED) === '1';
}

export function setKeyboardLettersEnabled(enabled: boolean): void {
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_LETTERS_ENABLED, enabled ? '1' : '0');
}
