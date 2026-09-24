import type { ParakeetVersion } from '../../../modules/parakeet-asr/src';
import type { TranscriptionResponse } from '../../types';
import { getPreferredTranscriptionLanguages } from '../../lib/transcriptionLanguage';
import { LocalParakeetService } from './LocalParakeetService';
import { LocalWhisperService } from './LocalWhisperService';
import {
  parakeetModelLabel,
  selectLocalEngine,
  preferredEngineForLanguages,
  type LocalEngineAvailability,
  type LocalEngineChoice,
} from './localEngine';

export interface LocalEngineDescriptor {
  engine: 'parakeet' | 'whisper';
  version?: ParakeetVersion;
  label: string;
}

export interface LocalTranscribeOptions {
  /** Single-language hint for the Whisper branch (today's behavior, passed through verbatim). */
  language?: string;
  wordTimestamps?: boolean;
  /** Whisper initial prompt (dictionary/snippet hints). Parakeet has no prompt input — dropped there. */
  prompt?: string;
}

function descriptorFor(
  preferred: ReturnType<typeof preferredEngineForLanguages>,
): LocalEngineDescriptor {
  if (preferred.engine === 'parakeet') {
    return {
      engine: 'parakeet',
      version: preferred.version,
      label: parakeetModelLabel(preferred.version),
    };
  }
  return { engine: 'whisper', label: 'Whisper base' };
}

/** The routed engine was Orukeet and loading it just failed, so re-routing picks another model. */
function orukeetFailedToLoad(choice: LocalEngineChoice): boolean {
  return (
    choice.engine === 'parakeet' &&
    choice.version === 'orukeet' &&
    LocalParakeetService.hasFailedToLoad('orukeet')
  );
}

function missingModelError(choice: Extract<LocalEngineChoice, { engine: 'none' }>): Error {
  const label =
    choice.preferred === 'whisper'
      ? 'Whisper'
      : choice.preferred === 'parakeet-v2'
        ? 'Parakeet v2'
        : 'Parakeet v3';
  // Message must satisfy isLocalModelMissingError (TranscriptionService.ts) so the Home
  // screen's download-or-cloud-once prompt keeps working.
  return new Error(`Model "${label}" is not available. Please download it first from Settings.`);
}

/**
 * Single entry point for on-device transcription. Routes each request to Orukeet, Parakeet
 * (v2/v3) or Whisper based on the user's selected languages and which models are installed —
 * callers never pick an engine themselves. Routing policy lives in localEngine.ts.
 */
export class LocalTranscriptionService {
  static isAvailable(): boolean {
    return LocalWhisperService.isAvailable() || LocalParakeetService.isAvailable();
  }

  static async getAvailability(): Promise<LocalEngineAvailability> {
    const parakeetSupported = LocalParakeetService.isAvailable();
    const orukeetSupported = parakeetSupported && LocalParakeetService.supportsVersion('orukeet');
    const [parakeetV2Downloaded, parakeetV3Downloaded, orukeetDownloaded] = parakeetSupported
      ? await Promise.all([
          LocalParakeetService.isModelDownloaded('v2'),
          LocalParakeetService.isModelDownloaded('v3'),
          orukeetSupported ? LocalParakeetService.isModelDownloaded('orukeet') : false,
        ])
      : [false, false, false];

    const whisperModels = LocalWhisperService.isAvailable()
      ? await LocalWhisperService.getAvailableModels()
      : [];

    return {
      parakeetSupported,
      parakeetV2Downloaded,
      parakeetV3Downloaded,
      // The fallback tier is specifically multilingual Whisper base. English-only or smaller
      // legacy artifacts must not make unsupported-language routes appear ready.
      whisperDownloaded: whisperModels.some((model) => model.name === 'base' && model.downloaded),
      orukeetSupported,
      orukeetDownloaded,
    };
  }

  private static async resolveEngine(): Promise<{
    languages: string[];
    choice: LocalEngineChoice;
  }> {
    const languages = getPreferredTranscriptionLanguages();
    const availability = await this.getAvailability();
    // An installed Orukeet that can't load on this device must not strand every in-set
    // dictation; route as if it weren't there until it loads again.
    const usable = LocalParakeetService.hasFailedToLoad('orukeet')
      ? { ...availability, orukeetDownloaded: false }
      : availability;
    return { languages, choice: selectLocalEngine(languages, usable) };
  }

  static async transcribe(
    audioUri: string,
    options: LocalTranscribeOptions = {},
  ): Promise<TranscriptionResponse> {
    const { languages, choice } = await this.resolveEngine();

    if (choice.engine === 'parakeet') {
      // Don't keep both runtimes' weights resident (~600 MB + ~500 MB) — release the idle one.
      await LocalWhisperService.cleanup();
      let response: TranscriptionResponse;
      try {
        response = await LocalParakeetService.transcribe(audioUri, {
          version: choice.version,
          // Exactly one selected language → pass the decoder hint; multi-in-v3 → auto language ID.
          language: languages.length === 1 ? languages[0] : undefined,
          wordTimestamps: options.wordTimestamps,
        });
      } catch (error) {
        if (orukeetFailedToLoad(choice)) return this.transcribe(audioUri, options);
        throw error;
      }
      const endpoint = choice.version === 'orukeet' ? 'orukeet' : `parakeet-${choice.version}`;
      return { ...response, endpoint };
    }

    if (choice.engine === 'whisper') {
      await LocalParakeetService.cleanup();
      const modelName = await LocalWhisperService.getRecommendedModelForLanguage(options.language);
      const response = await LocalWhisperService.transcribe(audioUri, {
        modelName,
        language: options.language,
        wordTimestamps: options.wordTimestamps,
        prompt: options.prompt,
      });
      return { ...response, endpoint: `whisper-${modelName}` };
    }

    throw missingModelError(choice);
  }

  /**
   * Warm the engine the current language selection routes to (keyboard/Home pre-warm path).
   * Never downloads; a Parakeet choice that isn't installed resolves to Whisper or a no-op.
   */
  static async prepareForLanguage(language?: string): Promise<void> {
    const { choice } = await this.resolveEngine();
    if (choice.engine === 'parakeet') {
      try {
        await LocalParakeetService.prepare(choice.version);
      } catch (error) {
        if (orukeetFailedToLoad(choice)) return this.prepareForLanguage(language);
        throw error;
      }
      return;
    }
    if (choice.engine === 'whisper') {
      await LocalWhisperService.prepareForLanguage(language);
    }
  }

  /** True when the engine the current selection routes to has its model installed. */
  static async isReadyForLanguage(): Promise<boolean> {
    const { choice } = await this.resolveEngine();
    return choice.engine !== 'none';
  }

  /** Display descriptor for the engine the current selection *should* use (installed or not). */
  static preferredEngineDescriptor(): LocalEngineDescriptor {
    return descriptorFor(preferredEngineForLanguages(getPreferredTranscriptionLanguages()));
  }

  static async cancelTranscription(): Promise<void> {
    await Promise.all([
      LocalWhisperService.cancelTranscription(),
      LocalParakeetService.cancelTranscription(),
    ]);
  }
}
