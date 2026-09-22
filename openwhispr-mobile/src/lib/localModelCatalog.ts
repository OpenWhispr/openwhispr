import type { ParakeetVersion } from '../../modules/parakeet-asr/src';
import {
  preferredEngineForLanguages,
  type LocalEngineAvailability,
} from '@/services/transcription/localEngine';

export type LocalModelKey = 'whisper-base' | 'parakeet-v2' | 'parakeet-v3' | 'orukeet';

/**
 * Nominal on-disk sizes shown before download (whisper from its published ggml size; Parakeet
 * measured on-device by the benchmark spike). Used for display and the pre-download
 * free-space check — close enough is fine.
 */
export const LOCAL_MODEL_SIZE_BYTES: Record<LocalModelKey, number> = {
  'whisper-base': 142 * 1024 * 1024,
  'parakeet-v2': 443 * 1024 * 1024,
  'parakeet-v3': 461 * 1024 * 1024,
  // Placeholder for the compiled install until a physical iPhone install is measured.
  orukeet: 600 * 1024 * 1024,
};

/** Orukeet's pinned zip (554,985,744 bytes). */
const ORUKEET_ARCHIVE_BYTES = 530 * 1024 * 1024;

/**
 * Most disk a download needs at once, for the free-space check. Models fetched straight into
 * place peak at their installed size. Orukeet's zip, its extracted packages and the compiled
 * models briefly coexist while it installs; 3× the zip is a placeholder until measured on device.
 */
export const LOCAL_MODEL_INSTALL_PEAK_BYTES: Record<LocalModelKey, number> = {
  'whisper-base': LOCAL_MODEL_SIZE_BYTES['whisper-base'],
  'parakeet-v2': LOCAL_MODEL_SIZE_BYTES['parakeet-v2'],
  'parakeet-v3': LOCAL_MODEL_SIZE_BYTES['parakeet-v3'],
  orukeet: 3 * ORUKEET_ARCHIVE_BYTES,
};

const PARAKEET_VERSION_BY_KEY: Record<LocalModelKey, ParakeetVersion | null> = {
  'whisper-base': null,
  'parakeet-v2': 'v2',
  'parakeet-v3': 'v3',
  orukeet: 'orukeet',
};

/** The native Parakeet-runtime version a model key installs, or null for Whisper. */
export function parakeetVersionForKey(key: LocalModelKey): ParakeetVersion | null {
  return PARAKEET_VERSION_BY_KEY[key];
}

export interface LocalModelCatalogEntry {
  key: LocalModelKey;
  engineName: 'Parakeet' | 'Orukeet' | 'Whisper';
  title: string;
  description: string;
  languagesNote: string;
  sizeBytes: number;
  recommended: boolean;
  downloaded: boolean;
}

/** The model the user's language selection should download (drives onboarding + recommendations). */
export function recommendedModelKey(languages: readonly string[]): LocalModelKey {
  const preferred = preferredEngineForLanguages(languages);
  if (preferred.engine === 'whisper') return 'whisper-base';
  return preferred.version === 'v2' ? 'parakeet-v2' : 'parakeet-v3';
}

/**
 * Display rows for the transcription-models screen: all installable engines with the one the
 * user's language selection routes to marked recommended (and listed first). Orukeet is opt-in, so
 * it is never recommended. Parakeet-runtime rows are omitted where the native module isn't linked
 * (Android, Expo Go).
 */
export function getLocalModelCatalog(
  languages: readonly string[],
  availability: LocalEngineAvailability,
): LocalModelCatalogEntry[] {
  const recommended = recommendedModelKey(languages);

  const entries: LocalModelCatalogEntry[] = [
    {
      key: 'parakeet-v2',
      engineName: 'Parakeet',
      title: 'Parakeet v2',
      description: 'Fastest and most accurate for English dictation.',
      languagesNote: 'English only',
      sizeBytes: LOCAL_MODEL_SIZE_BYTES['parakeet-v2'],
      recommended: recommended === 'parakeet-v2',
      downloaded: availability.parakeetV2Downloaded,
    },
    {
      key: 'parakeet-v3',
      engineName: 'Parakeet',
      title: 'Parakeet v3',
      description: 'Fast transcription with automatic language detection.',
      languagesNote: '25 European languages',
      sizeBytes: LOCAL_MODEL_SIZE_BYTES['parakeet-v3'],
      recommended: recommended === 'parakeet-v3',
      downloaded: availability.parakeetV3Downloaded,
    },
    {
      key: 'orukeet',
      engineName: 'Orukeet',
      title: 'Orukeet',
      description:
        'Parakeet fine-tune for multilingual dictation, English included. Used instead of Parakeet once downloaded.',
      languagesNote: '25 languages incl. English',
      sizeBytes: LOCAL_MODEL_SIZE_BYTES.orukeet,
      recommended: false,
      downloaded: availability.orukeetDownloaded,
    },
    {
      key: 'whisper-base',
      engineName: 'Whisper',
      title: 'Whisper base',
      description: 'Broad language coverage — the fallback for everything Parakeet doesn’t cover.',
      languagesNote: '~99 languages incl. auto-detect',
      sizeBytes: LOCAL_MODEL_SIZE_BYTES['whisper-base'],
      recommended: recommended === 'whisper-base',
      downloaded: availability.whisperDownloaded,
    },
  ];

  const visible = availability.parakeetSupported
    ? entries
    : entries.filter((entry) => entry.engineName === 'Whisper');

  // Recommended first; otherwise keep the declaration order (stable sort).
  return visible.sort((a, b) => Number(b.recommended) - Number(a.recommended));
}
