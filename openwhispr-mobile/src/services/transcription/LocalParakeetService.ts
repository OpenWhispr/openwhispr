import { ParakeetASR, type ParakeetVersion } from '../../../modules/parakeet-asr/src';
import type { TranscriptionResponse } from '../../types';
import {
  cancelParakeetDownload,
  downloadParakeetModel,
  stagedParakeetBytes,
} from './parakeetModelDownloader';
import { tokenTimingsToWhisperSegments } from './parakeetSegments';

export interface ParakeetTranscribeServiceOptions {
  version: ParakeetVersion;
  /** Base ISO code hint for v3's language filter; omit for auto language ID. Ignored by v2. */
  language?: string;
  wordTimestamps?: boolean;
}

/**
 * On-device Parakeet engine, mirroring LocalWhisperService's shape: a static singleton whose
 * native-touching operations are serialized on an operation chain so a release/delete can never
 * pull the warm engine out from under an in-flight transcription.
 *
 * Unlike Whisper there is no prompt/initial-hint input — dictation dictionary/snippet hints do
 * not apply to Parakeet. Accepted trade-off: raw accuracy is far better to begin with.
 */
export class LocalParakeetService {
  private static currentVersion: ParakeetVersion | null = null;
  private static operationChain: Promise<unknown> = Promise.resolve();

  private static runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  static isAvailable(): boolean {
    return ParakeetASR.isAvailable();
  }

  static async isModelDownloaded(version: ParakeetVersion): Promise<boolean> {
    return ParakeetASR.isModelDownloaded(version);
  }

  /** Installed weights plus any staged partial download for this version, in bytes (0 if neither exists). */
  static async modelSizeBytes(version: ParakeetVersion): Promise<number> {
    return ParakeetASR.modelSizeBytes(version);
  }

  // Deliberately NOT on the operation chain: the download touches only disk, never the warm
  // engine, so it can run while a transcription is in flight. The transfer itself is owned by
  // parakeetModelDownloader (background URLSession, resume, stall watchdog); FluidAudio only
  // loads what lands in its cache directory.
  static async downloadModel(
    version: ParakeetVersion,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    await downloadParakeetModel(version, { onProgress });
  }

  static async cancelModelDownload(version: ParakeetVersion): Promise<void> {
    await cancelParakeetDownload(version);
  }

  /** Bytes an interrupted or failed download left staged for this version; 0 when nothing is staged. */
  static async stagedDownloadBytes(version: ParakeetVersion): Promise<number> {
    return stagedParakeetBytes(version);
  }

  static async deleteModel(version: ParakeetVersion): Promise<void> {
    await this.runExclusive(async () => {
      if (this.currentVersion === version) {
        await ParakeetASR.release();
        this.currentVersion = null;
      }
      await ParakeetASR.deleteModel(version);
    });
  }

  /**
   * Load the downloaded weights + build the warm engine. Never downloads. The first prepare
   * after a download includes CoreML's one-time ANE compile — callers (download flow) own that
   * wait so a dictation tap never pays it.
   */
  static async prepare(version: ParakeetVersion): Promise<void> {
    await this.runExclusive(() => this.ensurePrepared(version));
  }

  private static async ensurePrepared(version: ParakeetVersion): Promise<void> {
    if (this.currentVersion === version) {
      return;
    }
    await ParakeetASR.prepare(version);
    this.currentVersion = version;
  }

  static async transcribe(
    audioUri: string,
    options: ParakeetTranscribeServiceOptions,
  ): Promise<TranscriptionResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        'Parakeet is not available. Build the app with `npx expo run:ios` to enable local transcription.',
      );
    }
    if (!(await ParakeetASR.isModelDownloaded(options.version))) {
      // Message must satisfy isLocalModelMissingError so the Home screen's
      // download-or-cloud-once fallback prompt keeps working.
      throw new Error(
        `Model "Parakeet ${options.version}" is not available. Please download it first from Settings.`,
      );
    }

    return this.runExclusive(async () => {
      await this.ensurePrepared(options.version);

      const startTime = Date.now();
      const result = await ParakeetASR.transcribe(audioUri, options.version, {
        language: options.language,
        tokenTimings: options.wordTimestamps ?? false,
      });

      return {
        text: result.text.trim(),
        duration: result.audioSeconds,
        provider: 'local' as const,
        processingMs: Date.now() - startTime,
        ...(options.wordTimestamps
          ? { segments: tokenTimingsToWhisperSegments(result.tokenTimings ?? []) }
          : {}),
      };
    });
  }

  /**
   * AsrManager has no mid-flight cancel: this enqueues a release behind any in-flight run, which
   * then completes natively with its result discarded by the caller — the same effective
   * semantics as LocalWhisperService.cancelTranscription.
   */
  static async cancelTranscription(): Promise<void> {
    await this.runExclusive(() => this.releaseEngine());
  }

  static async cleanup(): Promise<void> {
    await this.runExclusive(() => this.releaseEngine());
  }

  private static async releaseEngine(): Promise<void> {
    if (this.currentVersion === null) {
      return;
    }
    await ParakeetASR.release();
    this.currentVersion = null;
  }
}
