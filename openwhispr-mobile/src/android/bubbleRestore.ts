import { AppState } from 'react-native';
import { AndroidDictation } from '../../modules/android-dictation/src';

function restore() {
  try {
    AndroidDictation?.restoreBubble();
  } catch (error) {
    console.warn('[bubble] restore failed', error);
  }
}

/**
 * Brings the floating bubble back when OpenWhispr opens or returns to the front, if the user left it
 * on. Covers an update or restart Android didn't let the bubble survive, and permissions granted
 * again in Settings.
 */
export function observeBubbleRestore(): () => void {
  restore();
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') restore();
  });
  return () => subscription.remove();
}
