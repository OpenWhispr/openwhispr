import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

interface LiveActivityNativeModule {
  startSession(): void;
  endSession(): void;
  setDictationMode(enabled: boolean): void;
  isDictationModeEnabled(): boolean;
}

const NativeModule: LiveActivityNativeModule | null =
  Platform.OS === 'ios' ? requireNativeModule('LiveActivity') : null;

export const LiveActivity = {
  /** Start the session Live Activity (no-op unless dictation mode is on, app is
   *  foreground, iOS 16.2+, and none is already running). */
  startSession(): void {
    NativeModule?.startSession();
  },
  /** End the session Live Activity immediately. */
  endSession(): void {
    NativeModule?.endSession();
  },
  /** Enable/disable dictation mode. Enabling (while foreground) starts the
   *  activity; disabling ends it. Persisted in the app group. */
  setDictationMode(enabled: boolean): void {
    NativeModule?.setDictationMode(enabled);
  },
  /** Current dictation-mode flag (false off iOS). */
  isDictationModeEnabled(): boolean {
    return NativeModule?.isDictationModeEnabled() ?? false;
  },
};
