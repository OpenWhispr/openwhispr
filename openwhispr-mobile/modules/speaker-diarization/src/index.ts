import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

/** One diarized turn from the native engine. Times are in SECONDS; speakerId is the engine's string label. */
export interface NativeDiarSegment {
  startTime: number;
  endTime: number;
  speakerId: string;
  /** Per-segment speaker embedding; the native module always emits this array (FluidAudio `TimedSpeakerSegment.embedding: [Float]`). */
  embedding: number[];
}

export interface NativeDiarizationResult {
  segments: NativeDiarSegment[];
  /** Per-speaker centroid embeddings keyed by the engine's string speaker id (may be absent). */
  speakerDatabase?: Record<string, number[]> | null;
}

interface NativeSpeakerDiarization {
  isModelDownloaded(): Promise<boolean>;
  downloadModel(): Promise<void>;
  deleteModel(): Promise<void>;
  diarize(wavUri: string, numberOfSpeakers: number): Promise<NativeDiarizationResult>;
}

// iOS-only (FluidAudio runs on the Neural Engine; the module is not built for other platforms).
// Returns null off-iOS or when the native module is not linked (e.g. Expo Go), so callers degrade gracefully.
const NativeModule: NativeSpeakerDiarization | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireNativeModule('SpeakerDiarization');
  } catch {
    return null;
  }
})();

export const SpeakerDiarization = {
  isAvailable(): boolean {
    return NativeModule !== null;
  },

  /** True if the FluidAudio CoreML weights are already on disk (no network needed to diarize). */
  async isModelDownloaded(): Promise<boolean> {
    return NativeModule ? NativeModule.isModelDownloaded() : false;
  },

  /** Download the ~100 MB FluidAudio weights with the user's consent. No-op off-iOS. */
  async downloadModel(): Promise<void> {
    if (NativeModule) await NativeModule.downloadModel();
  },

  /** Delete the on-device FluidAudio weights to reclaim storage. No-op off-iOS. */
  async deleteModel(): Promise<void> {
    if (NativeModule) await NativeModule.deleteModel();
  },

  /**
   * Diarize a 16 kHz mono WAV. Assumes the model is already downloaded.
   * @param numberOfSpeakers exact speaker-count hint; 0 = auto-detect.
   */
  async diarize(wavUri: string, numberOfSpeakers = 0): Promise<NativeDiarizationResult> {
    if (!NativeModule) {
      throw new Error('SpeakerDiarization is only available on iOS 17+.');
    }
    return NativeModule.diarize(wavUri, numberOfSpeakers);
  },
};
