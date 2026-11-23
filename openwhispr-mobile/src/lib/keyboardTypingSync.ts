import { AppState } from 'react-native';
import type { KeyboardTypingLanguage, KeyboardTypingLayout, UserConfig } from '@/types';
import { useConfigStore } from '@/store/useConfigStore';
import { AppGroupStorage } from '../../modules/app-group-storage/src';

/**
 * What the keyboard reads from the App Group for typing (not dictation). Keep the keys and
 * values in step with the Swift keyboard in plugins/keyboard-extension/ios. A missing language
 * follows the device's preferred languages, a missing layout follows the language, and missing
 * haptics are on. The keyboard also writes the language and layout when the user switches them
 * there, so those two are read back before they are mirrored out.
 */
export const KEYBOARD_TYPING_KEYS = {
  LANGUAGE: 'keyboard_typing_language',
  LAYOUT: 'keyboard_typing_layout',
  HAPTICS_ENABLED: 'keyboard_haptics_enabled',
  LEARNED_WORDS_CLEARED_AT_MS: 'keyboard_learned_words_cleared_at_ms',
} as const;

export const KEYBOARD_TYPING_LANGUAGES: { value: KeyboardTypingLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr_CH', label: 'Français (Suisse)' },
  { value: 'other', label: 'Other (no typing help)' },
];

export const KEYBOARD_TYPING_LAYOUTS: { value: KeyboardTypingLayout; label: string }[] = [
  { value: 'qwerty', label: 'QWERTY' },
  { value: 'qwertz', label: 'QWERTZ' },
];

// Anything else in a saved config reads as unset, so the keyboard's own default applies.
function knownValue<Value extends string>(
  options: { value: Value }[],
  value: string | null | undefined,
): Value | null {
  return options.find((option) => option.value === value)?.value ?? null;
}

export function keyboardTypingLanguage(config: UserConfig | null): KeyboardTypingLanguage | null {
  return knownValue(KEYBOARD_TYPING_LANGUAGES, config?.keyboardTypingLanguage);
}

export function keyboardTypingLayout(config: UserConfig | null): KeyboardTypingLayout | null {
  return knownValue(KEYBOARD_TYPING_LAYOUTS, config?.keyboardTypingLayout);
}

export function keyboardHapticsEnabled(config: UserConfig | null): boolean {
  return config?.keyboardHapticsEnabled ?? true;
}

function writeOrRemove(key: string, value: string | null): void {
  if (value === null) AppGroupStorage.removeItem(key);
  else AppGroupStorage.setItem(key, value);
}

function writeKeyboardTypingKeys(): void {
  const config = useConfigStore.getState().config;
  writeOrRemove(KEYBOARD_TYPING_KEYS.LANGUAGE, keyboardTypingLanguage(config));
  writeOrRemove(KEYBOARD_TYPING_KEYS.LAYOUT, keyboardTypingLayout(config));
  AppGroupStorage.setItem(
    KEYBOARD_TYPING_KEYS.HAPTICS_ENABLED,
    keyboardHapticsEnabled(config) ? '1' : '0',
  );
}

// The setters write the App Group key at once, so the keyboard has the choice without waiting
// on config persistence (as setKeyboardTone does).
export function setKeyboardTypingLanguage(language: KeyboardTypingLanguage | null): void {
  writeOrRemove(KEYBOARD_TYPING_KEYS.LANGUAGE, language);
  useConfigStore
    .getState()
    .updateConfig({ keyboardTypingLanguage: language })
    .catch(() => {});
}

export function setKeyboardTypingLayout(layout: KeyboardTypingLayout | null): void {
  writeOrRemove(KEYBOARD_TYPING_KEYS.LAYOUT, layout);
  useConfigStore
    .getState()
    .updateConfig({ keyboardTypingLayout: layout })
    .catch(() => {});
}

export function setKeyboardHapticsEnabled(enabled: boolean): void {
  AppGroupStorage.setItem(KEYBOARD_TYPING_KEYS.HAPTICS_ENABLED, enabled ? '1' : '0');
  useConfigStore
    .getState()
    .updateConfig({ keyboardHapticsEnabled: enabled })
    .catch(() => {});
}

/** The keyboard forgets every word it learned the next time it opens. */
export function clearKeyboardLearnedWords(): void {
  AppGroupStorage.setItem(KEYBOARD_TYPING_KEYS.LEARNED_WORDS_CLEARED_AT_MS, String(Date.now()));
}

// Takes a language or layout the user switched in the keyboard into config, so Preferences shows
// it and the mirror doesn't undo it. A missing or invalid App Group value leaves config as the
// source of truth.
export async function reconcileKeyboardTypingFromAppGroup(): Promise<void> {
  const config = useConfigStore.getState().config;
  const language = knownValue(
    KEYBOARD_TYPING_LANGUAGES,
    AppGroupStorage.getItem(KEYBOARD_TYPING_KEYS.LANGUAGE),
  );
  const layout = knownValue(
    KEYBOARD_TYPING_LAYOUTS,
    AppGroupStorage.getItem(KEYBOARD_TYPING_KEYS.LAYOUT),
  );
  const updates: Partial<UserConfig> = {};
  if (language && language !== keyboardTypingLanguage(config)) {
    updates.keyboardTypingLanguage = language;
  }
  if (layout && layout !== keyboardTypingLayout(config)) updates.keyboardTypingLayout = layout;
  if (Object.keys(updates).length > 0) await useConfigStore.getState().updateConfig(updates);
}

let reconciling = false;

// Saving config notifies subscribers before the new value lands, which would write the old
// language or layout over the keyboard's.
function mirrorUnlessReconciling(): void {
  if (!reconciling) writeKeyboardTypingKeys();
}

async function guardedReconcile(): Promise<void> {
  reconciling = true;
  try {
    await reconcileKeyboardTypingFromAppGroup();
  } finally {
    reconciling = false;
    writeKeyboardTypingKeys();
  }
}

/**
 * Keeps the typing preferences and the App Group in step: at start and whenever the app comes
 * to the foreground the keyboard's own language and layout are adopted first, then config is
 * mirrored out, as it is on every config change.
 */
export function startKeyboardTypingSync(): () => void {
  guardedReconcile().catch(() => {});

  const unsubConfig = useConfigStore.subscribe(mirrorUnlessReconciling);
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') guardedReconcile().catch(() => {});
  });

  return () => {
    unsubConfig();
    appStateSub.remove();
  };
}
