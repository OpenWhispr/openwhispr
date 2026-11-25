// The keyboard's Keyboard Settings… opens <scheme>://keyboard-settings, which expo-router lands on
// Preferences (app/keyboard-settings.tsx). On a warm resume the link arrives ahead of
// `didBecomeActive`, so without this stamp the resume reset in app/_layout.tsx would replace
// Preferences with Home before the user saw it (see resolveResumeAction).
export const KEYBOARD_SETTINGS_ROUTE = 'keyboard-settings';

const FRESH_MS = 5_000;

let openedAt = 0;

export function markKeyboardSettingsLink(): void {
  openedAt = Date.now();
}

export function isKeyboardSettingsLinkFresh(): boolean {
  const age = Date.now() - openedAt;
  return openedAt > 0 && age >= 0 && age < FRESH_MS;
}
