import { useConfigStore } from '@/store/useConfigStore';
import { AppGroupStorage, APP_GROUP_KEYS } from '../../modules/app-group-storage/src';

// Start after config hydration. Only persisted changes reach the extension, so
// a failed save cannot leave the keyboard and its Settings switch disagreeing.
export function startKeyboardLayoutSync(): () => void {
  const write = (): void => {
    AppGroupStorage.setItem(
      APP_GROUP_KEYS.KEYBOARD_MINIMAL_ENABLED,
      useConfigStore.getState().config?.minimalKeyboardEnabled === true ? '1' : '0',
    );
  };
  write();
  return useConfigStore.subscribe(write);
}
