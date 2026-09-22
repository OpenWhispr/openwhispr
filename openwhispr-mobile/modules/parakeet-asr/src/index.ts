import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

type EventSubscription = {
  remove(): void;
};

/**
 * The shipped models. Precision is fixed at int8 (applies to v3 only; v2 ignores it). Orukeet is
 * a fine-tune of the v3 architecture served by the same runtime; only its install path differs.
 */
export type ParakeetVersion = 'v2' | 'v3' | 'orukeet';

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

/** A version fetched file by file from a HuggingFace repo tree into the layout FluidAudio loads from. */
export interface HfTreeModelSpec {
  kind: 'hf-tree';
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

/**
 * A version shipped as one pinned zip that JS downloads and the native installer verifies,
 * extracts and compiles on device (`installFromArchive`).
 */
export interface ArchiveModelSpec {
  kind: 'archive';
  /** Immutable, commit-pinned download URL. */
  archiveUrl: string;
  archiveBytes: number;
  /** Lowercase hex SHA-256 the native installer verifies before extracting. */
  archiveSha256: string;
  /** Absolute path (no file:// scheme) JS downloads the zip into. */
  stagingDirectory: string;
  /** Absolute path (no file:// scheme) of the verified install, or null until one exists. */
  installedDirectory: string | null;
}

/** What the JS downloader needs to fetch one version. */
export type ParakeetModelSpec = HfTreeModelSpec | ArchiveModelSpec;

/** Installer phases, in order, as reported by `installFromArchive`. */
export type ParakeetInstallPhase =
  | 'checkingCache'
  | 'verifying'
  | 'extracting'
  | 'compiling'
  | 'ready';

export interface ParakeetInstallProgressEvent {
  version: ParakeetVersion;
  phase: ParakeetInstallPhase;
  /** Fraction of the current phase in [0, 1]; null where the phase is indeterminate. */
  fraction: number | null;
}

/** Native `installFromArchive` rejects with this code when the archive fails its size or SHA-256 check. */
export const ARCHIVE_VERIFICATION_ERROR_CODE = 'ARCHIVE_VERIFICATION_ERROR';

type ParakeetASREvents = {
  parakeetInstallProgress: (event: ParakeetInstallProgressEvent) => void;
};

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
  installFromArchive(version: ParakeetVersion, archivePath: string): Promise<void>;
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
  // Expo native modules are event emitters (SDK 52+).
  addListener<EventName extends keyof ParakeetASREvents>(
    eventName: EventName,
    listener: ParakeetASREvents[EventName],
  ): EventSubscription;
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

  /**
   * Whether this binary's native module can serve a version. JS can reach a binary older than
   * itself through an OTA update, and binaries without `installFromArchive` reject 'orukeet'.
   */
  supportsVersion(version: ParakeetVersion): boolean {
    if (!NativeModule) return false;
    return version !== 'orukeet' || typeof NativeModule.installFromArchive === 'function';
  },

  async isModelDownloaded(version: ParakeetVersion): Promise<boolean> {
    return this.supportsVersion(version) ? requireNative().isModelDownloaded(version) : false;
  },

  /** How to fetch a version: its HuggingFace tree, or its pinned archive (see ParakeetModelSpec). */
  async modelSpec(version: ParakeetVersion): Promise<ParakeetModelSpec> {
    return requireNative().modelSpec(version);
  },

  /**
   * Verify, extract and compile a downloaded archive (absolute path, no file:// scheme) into the
   * version's install directory. Never modifies or deletes the archive.
   */
  async installFromArchive(version: ParakeetVersion, archivePath: string): Promise<void> {
    return requireNative().installFromArchive(version, archivePath);
  },

  /** Phases of a running `installFromArchive`. Null without the native module. */
  addInstallProgressListener(
    listener: (event: ParakeetInstallProgressEvent) => void,
  ): EventSubscription | null {
    return NativeModule ? NativeModule.addListener('parakeetInstallProgress', listener) : null;
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
