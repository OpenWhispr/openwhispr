import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

/** The two shipped Parakeet variants. Precision is fixed at int8 (applies to v3 only; v2 ignores it). */
export type ParakeetVersion = 'v2' | 'v3';

/** Word-piece timing from the TDT decoder. Times are seconds from the start of the clip. */
export interface ParakeetTokenTiming {
  token: string;
  startTime: number;
  endTime: number;
  confidence: number;
}

export interface ParakeetTranscribeOptions {
  /**
   * Base ISO-639-1 code feeding the v3 decoder's language filter. Omit for auto language ID.
   * Ignored for v2 (English-only).
   */
  language?: string;
  /** Include word-piece timings in the result (used for meeting diarization word timestamps). */
  tokenTimings?: boolean;
  /** Benchmark-only: bracket the run with the native peak-memory sampler. */
  sampleMemory?: boolean;
}

/** Result of a single transcription run. Timings from FluidAudio's own inference clock. */
export interface ParakeetTranscribeResult {
  text: string;
  confidence: number;
  /** Real-time factor (audioDuration / processingTime); higher = faster than real time. */
  rtfx: number;
  /** Pure inference time in ms (excludes model load, which prepare() measures). */
  inferMs: number;
  audioSeconds: number;
  /** Present only when requested via options.tokenTimings. */
  tokenTimings?: ParakeetTokenTiming[];
  /** Present only when requested via options.sampleMemory. */
  peakBytes?: number;
  baselineBytes?: number;
  minAvailableBytes?: number;
}

export interface ParakeetPrepareResult {
  /** Pure load time (no network). First load after a download includes CoreML's one-time ANE compile. */
  loadMs: number;
  modelSizeBytes: number;
}

/** What the JS downloader needs to fetch one version into the layout FluidAudio loads from. */
export interface ParakeetModelSpec {
  /** HuggingFace repo id, e.g. "FluidInference/parakeet-tdt-0.6b-v2-coreml". */
  repo: string;
  /** Absolute path (no file:// scheme) of the directory FluidAudio loads this version from. */
  directory: string;
  /**
   * Absolute path (no file:// scheme) of the staging directory JS downloads into before the
   * atomic rename into `directory`.
   */
  stagingDirectory: string;
  /** Top-level entries FluidAudio requires inside `directory`: `.mlmodelc` bundles + the vocab json. */
  entries: string[];
}

export interface DeviceInfo {
  /** Hardware identifier, e.g. "iPhone17,1". */
  model: string;
  totalMemoryBytes: number;
  osVersion: string;
}

export interface MemorySample {
  peakBytes: number;
  baselineBytes: number;
  minAvailableBytes: number;
}

interface NativeParakeetASR {
  isModelDownloaded(version: ParakeetVersion): Promise<boolean>;
  modelSpec(version: ParakeetVersion): Promise<ParakeetModelSpec>;
  deleteModel(version: ParakeetVersion): Promise<void>;
  modelSizeBytes(version: ParakeetVersion): Promise<number>;
  deviceInfo(): Promise<DeviceInfo>;
  prepare(version: ParakeetVersion): Promise<ParakeetPrepareResult>;
  transcribe(
    wavUri: string,
    version: ParakeetVersion,
    options: ParakeetTranscribeOptions,
  ): Promise<ParakeetTranscribeResult>;
  release(): Promise<void>;
  startMemorySampling(): Promise<void>;
  stopMemorySampling(): Promise<MemorySample>;
}

// iOS-only (FluidAudio runs on the Neural Engine). Returns null off-iOS or when the native module
// is not linked (e.g. Expo Go), so callers degrade gracefully instead of crashing.
const NativeModule: NativeParakeetASR | null = (() => {
  if (Platform.OS !== 'ios') return null;
  try {
    return requireNativeModule('ParakeetASR');
  } catch {
    return null;
  }
})();

function requireNative(): NativeParakeetASR {
  if (!NativeModule) {
    throw new Error('ParakeetASR is only available on a native iOS 17+ build (not Expo Go).');
  }
  return NativeModule;
}

export const ParakeetASR = {
  isAvailable(): boolean {
    return NativeModule !== null;
  },

  async isModelDownloaded(version: ParakeetVersion): Promise<boolean> {
    return NativeModule ? NativeModule.isModelDownloaded(version) : false;
  },

  /** Repo id, install and staging directories, and required entries for a version, from FluidAudio's own model tables. */
  async modelSpec(version: ParakeetVersion): Promise<ParakeetModelSpec> {
    return requireNative().modelSpec(version);
  },

  async deleteModel(version: ParakeetVersion): Promise<void> {
    if (NativeModule) await NativeModule.deleteModel(version);
  },

  /** Installed weights plus any staged partial download for this version, in bytes (0 if neither exists). */
  async modelSizeBytes(version: ParakeetVersion): Promise<number> {
    return NativeModule ? NativeModule.modelSizeBytes(version) : 0;
  },

  async deviceInfo(): Promise<DeviceInfo> {
    return requireNative().deviceInfo();
  },

  /**
   * Load already-downloaded weights + build the warm engine. Never downloads. The first load
   * after a download includes CoreML's one-time ANE compile — the download UI owns that wait.
   */
  async prepare(version: ParakeetVersion): Promise<ParakeetPrepareResult> {
    return requireNative().prepare(version);
  },

  /** Run one transcription on the prepared engine. Call prepare(version) first. */
  async transcribe(
    wavUri: string,
    version: ParakeetVersion,
    options: ParakeetTranscribeOptions = {},
  ): Promise<ParakeetTranscribeResult> {
    return requireNative().transcribe(wavUri, version, options);
  },

  /** Release the warm engine + its models (frees ~600 MB; next transcribe needs prepare again). */
  async release(): Promise<void> {
    if (NativeModule) await NativeModule.release();
  },

  /** Bracket a non-Parakeet run (e.g. Whisper benchmark) with the identical native peak-memory sampler. */
  async startMemorySampling(): Promise<void> {
    await requireNative().startMemorySampling();
  },

  async stopMemorySampling(): Promise<MemorySample> {
    return requireNative().stopMemorySampling();
  },
};
