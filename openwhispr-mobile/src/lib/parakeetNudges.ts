import {
  preferredEngineForLanguages,
  type LocalEngineAvailability,
} from '@/services/transcription/localEngine';
import type { ProcessingMode, UserConfig } from '@/types';

export interface ParakeetNudge {
  kind: 'pick-language' | 'faster-model';
  /**
   * Base ISO code to personalize the copy with ("Dictating in English?…"). Present when the
   * device's detected languages (pick-language) or the user's selection (faster-model) map to a
   * Parakeet-eligible setup; absent → use generic copy.
   */
  suggestedLanguageCode?: string;
}

export interface ParakeetNudgeInput {
  activeMode: ProcessingMode;
  /** The user's selected languages (getPreferredTranscriptionLanguages()); [] = auto. */
  languages: readonly string[];
  /** Detected device/keyboard languages (detectPreferredLanguages()). */
  deviceLanguages: readonly string[];
  availability: LocalEngineAvailability;
  config: Pick<
    UserConfig,
    'parakeetAutoLanguageNudgeDismissedAt' | 'parakeetUpgradeNudgeDismissedAt'
  >;
}

/**
 * Which one-time Parakeet banner (if any) to show on Home. Pure decision logic — dismissal
 * writes and navigation live in the banner component. Never fires outside private mode, and a
 * completed Parakeet download permanently satisfies the 'faster-model' nudge (the download flow
 * stamps the dismissal flag).
 */
export function getParakeetNudge(input: ParakeetNudgeInput): ParakeetNudge | null {
  const { activeMode, languages, deviceLanguages, availability, config } = input;
  if (activeMode !== 'private' || !availability.parakeetSupported) {
    return null;
  }

  const preferred = preferredEngineForLanguages(languages);

  if (preferred.engine === 'parakeet') {
    const downloaded =
      preferred.version === 'v2'
        ? availability.parakeetV2Downloaded
        : availability.parakeetV3Downloaded;
    if (downloaded || config.parakeetUpgradeNudgeDismissedAt) {
      return null;
    }
    return { kind: 'faster-model', suggestedLanguageCode: languages[0] };
  }

  // Selection routes to Whisper ('auto' or a set Parakeet can't cover). Suggest picking a
  // language when the device's own languages would qualify.
  if (config.parakeetAutoLanguageNudgeDismissedAt) {
    return null;
  }
  const devicePreferred = preferredEngineForLanguages(deviceLanguages);
  return {
    kind: 'pick-language',
    ...(devicePreferred.engine === 'parakeet'
      ? { suggestedLanguageCode: deviceLanguages[0]?.split('-')[0] }
      : {}),
  };
}
