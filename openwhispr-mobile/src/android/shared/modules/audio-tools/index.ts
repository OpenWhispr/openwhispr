import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface TranscodeResult {
  uri: string;
  durationMs: number;
}

export interface ChunkResult {
  chunks: string[];
  durationMs: number;
}

interface NativeAudioTools {
  transcodeToWav(inputUri: string): Promise<TranscodeResult>;
  splitToChunks(inputUri: string, segmentSeconds: number): Promise<ChunkResult>;
  splitOggOpus(inputUri: string, maxBytes: number): Promise<ChunkResult>;
  cleanup(uris: string[]): Promise<void>;
}

const NativeModule: NativeAudioTools | null =
  Platform.OS === 'ios' ? requireNativeModule('AudioTools') : null;

export const AudioTools = {
  isAvailable(): boolean {
    return NativeModule !== null;
  },

  /**
   * Decodes any supported audio file into a 16kHz mono 16-bit PCM WAV temp file,
   * the only format whisper.rn can read. Caller owns the returned file and must
   * pass its uri to cleanup() once done.
   */
  async transcodeToWav(inputUri: string): Promise<TranscodeResult> {
    if (!NativeModule) {
      throw new Error('AudioTools is only available on iOS');
    }
    return NativeModule.transcodeToWav(inputUri);
  },

  /**
   * Decodes an audio file into 16kHz mono WAV segments of segmentSeconds each,
   * small enough to upload individually. WAV (not a compressed format) is used
   * so the cloud's magic-byte format detection reliably recognizes each chunk.
   * Caller owns the returned files and must pass them to cleanup() once done.
   */
  async splitToChunks(inputUri: string, segmentSeconds: number): Promise<ChunkResult> {
    if (!NativeModule) {
      throw new Error('AudioTools is only available on iOS');
    }
    return NativeModule.splitToChunks(inputUri, segmentSeconds);
  },

  /**
   * Re-paginates an Ogg-Opus file into standalone Ogg-Opus chunks under maxBytes
   * each, without decoding the audio (AVFoundation can't read Opus). Used to get
   * large Opus files past the cloud request-size cap. Caller owns the returned
   * files and must pass them to cleanup() once done.
   */
  async splitOggOpus(inputUri: string, maxBytes: number): Promise<ChunkResult> {
    if (!NativeModule) {
      throw new Error('AudioTools is only available on iOS');
    }
    return NativeModule.splitOggOpus(inputUri, maxBytes);
  },

  async cleanup(uris: string[]): Promise<void> {
    if (!NativeModule || uris.length === 0) {
      return;
    }
    await NativeModule.cleanup(uris);
  },
};
