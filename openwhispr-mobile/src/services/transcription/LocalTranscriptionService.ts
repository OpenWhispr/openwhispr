import type { ParakeetVersion } from '../../../modules/parakeet-asr/src';
import type { TranscriptionResponse } from '../../types';
import { getPreferredTranscriptionLanguages } from '../../lib/transcriptionLanguage';
import { LocalParakeetService } from './LocalParakeetService';
import { LocalWhisperService } from './LocalWhisperService';
import {
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
      label: preferred.version === 'v2' ? 'Parakeet v2' : 'Parakeet v3',
    };
  }
  return { engine: 'whisper', label: 'Whisper base' };
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
 * Single entry point for on-device transcription. Routes each request to Parakeet (v2/v3) or
 * Whisper based on the user's selected languages and which models are installed — callers never
 * pick an engine themselves. Routing policy lives in localEngine.ts.
 */
export class LocalTranscriptionService {
  static isAvailable(): boolean {
    return LocalWhisperService.isAvailable() || LocalParakeetService.isAvailable();
  }

  static async getAvailability(): Promise<LocalEngineAvailability> {
    const parakeetSupported = LocalParakeetService.isAvailable();
    const [parakeetV2Downloaded, parakeetV3Downloaded] = parakeetSupported
      ? await Promise.all([
          LocalParakeetService.isModelDownloaded('v2'),
          LocalParakeetService.isModelDownloaded('v3'),
        ])
      : [false, false];

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
    };
  }

  private static async resolveEngine(): Promise<{
    languages: string[];
    choice: LocalEngineChoice;
  }> {
    const languages = getPreferredTranscriptionLanguages();
    const availability = await this.getAvailability();
    return { languages, choice: selectLocalEngine(languages, availability) };
  }

  static async transcribe(
    audioUri: string,
    options: LocalTranscribeOptions = {},
  ): Promise<TranscriptionResponse> {
    const { languages, choice } = await this.resolveEngine();

    if (choice.engine === 'parakeet') {
      // Don't keep both runtimes' weights resident (~600 MB + ~500 MB) — release the idle one.
      await LocalWhisperService.cleanup();
      const response = await LocalParakeetService.transcribe(audioUri, {
        version: choice.version,
        // Exactly one selected language → pass the decoder hint; multi-in-v3 → auto language ID.
        language: languages.length === 1 ? languages[0] : undefined,
        wordTimestamps: options.wordTimestamps,
      });
      return { ...response, endpoint: `parakeet-${choice.version}` };
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
      await LocalParakeetService.prepare(choice.version);
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
