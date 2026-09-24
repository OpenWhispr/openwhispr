import { AppGroupStorage } from '../../modules/app-group-storage/src';

// PrimaryLanguage declared by the keyboard extension's Info.plist. iOS reports it
// as the input mode's primaryLanguage once the user adds the keyboard.
export const OPENWHISPR_KEYBOARD_TAG = 'mul';

// Reports whether the user has ADDED the keyboard in Settings. This says nothing
// about Full Access: activeInputModes is readable either way, which is why the
// onboarding check alone can't tell a working keyboard from a mute one.
export function isKeyboardInstalled(): boolean {
  return AppGroupStorage.getActiveInputModes().includes(OPENWHISPR_KEYBOARD_TAG);
}
