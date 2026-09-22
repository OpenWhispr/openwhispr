import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

interface PipTutorialNativeModule {
  isAvailable(): boolean;
  start(videoName: string): Promise<boolean>;
  stop(): Promise<void>;
}

let NativeModule: PipTutorialNativeModule | null = null;
if (Platform.OS === 'ios') {
  try {
    NativeModule = requireNativeModule('PipTutorial');
  } catch (error) {
    if (__DEV__) {
      console.warn(
        '[PipTutorial] Native module not linked yet. Run `npx expo prebuild --clean` and rebuild. ' +
          'PiP will be a no-op until then.',
        (error as Error)?.message ?? error,
      );
    }
  }
}

export const PipTutorial = {
  /**
   * Whether the device supports Picture-in-Picture. Returns false on
   * unsupported devices (older iPads, simulator in some configurations) and
   * always false on non-iOS platforms.
   */
  isAvailable(): boolean {
    if (!NativeModule) return false;
    try {
      return NativeModule.isAvailable();
    } catch {
      return false;
    }
  },

  /**
   * Start playing the named tutorial video in a Picture-in-Picture overlay.
   * The video must be bundled in modules/pip-tutorial/ios/Resources/ as
   * `<videoName>.mp4` so it ends up in the main app bundle at runtime.
   *
   * Returns `true` if PiP was successfully prepared, `false` if the device
   * doesn't support PiP or the named video isn't bundled. Caller should fall
   * back to a static overlay when this returns false.
   */
  async start(videoName: string): Promise<boolean> {
    if (!NativeModule) return false;
    try {
      return await NativeModule.start(videoName);
    } catch {
      return false;
    }
  },

  async stop(): Promise<void> {
    if (!NativeModule) return;
    try {
      await NativeModule.stop();
    } catch {
      // ignore — best-effort teardown
    }
  },
};
