import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

interface PipTutorialNativeModule {
  isAvailable(): boolean;
  // Builds before start reported an outcome resolve a boolean, and an OTA update can run this JS
  // on one of them.
  start(videoName: string): Promise<PipStartOutcome | boolean>;
  stop(): Promise<void>;
}

/**
 * `started`, or why the overlay isn't showing. `stopped`: a later start or a stop replaced it.
 * `unavailable`: the iOS module isn't linked. `failed`: an older native build gave no reason.
 */
export type PipStartOutcome =
  | 'started'
  | 'unsupported'
  | 'video_missing'
  | 'no_root_view'
  | 'controller_failed'
  | 'stopped'
  | 'unavailable'
  | 'error'
  | 'failed'
  | `timeout:possible=${boolean}`
  | `failed:${string}`;

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
   * Resolves `started` once the overlay is showing, otherwise the reason it
   * isn't (see `PipStartOutcome`). Never rejects.
   */
  async start(videoName: string): Promise<PipStartOutcome> {
    if (!NativeModule) return 'unavailable';
    try {
      const outcome = await NativeModule.start(videoName);
      if (typeof outcome === 'string') return outcome;
      return outcome ? 'started' : 'failed';
    } catch {
      return 'error';
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
