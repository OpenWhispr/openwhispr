import { AppState } from 'react-native';
import type { KeyboardLetterLayout } from '@/types';
import { coerceLetterLayout } from '@/lib/keyboardLayout';
import { useConfigStore } from '@/store/useConfigStore';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// The layout is chosen only in the app, so config is the source of truth and the App Group
// key is a mirror the keyboard reads each time it appears.
function writeAppGroupLetterLayout(): void {
  const layout = coerceLetterLayout(useConfigStore.getState().config?.keyboardLetterLayout);
  if (AppGroupStorage.getItem(APP_GROUP_KEYS.KEYBOARD_LETTER_LAYOUT) !== layout) {
    AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_LETTER_LAYOUT, layout);
  }
}

// Writes the App Group key at once, so the keyboard shows the new keys the next time it
// opens even if saving the config is still in flight.
export function setKeyboardLetterLayout(layout: KeyboardLetterLayout): void {
  AppGroupStorage.setItem(APP_GROUP_KEYS.KEYBOARD_LETTER_LAYOUT, layout);
  useConfigStore
    .getState()
    .updateConfig({ keyboardLetterLayout: layout })
    .catch(() => {});
}

export function startKeyboardLayoutSync(): () => void {
  writeAppGroupLetterLayout();

  const unsubConfig = useConfigStore.subscribe(writeAppGroupLetterLayout);
  const appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      writeAppGroupLetterLayout();
    }
  });

  return () => {
    unsubConfig();
    appStateSub.remove();
  };
}
