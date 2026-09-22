import type { ParakeetVersion } from '../../modules/parakeet-asr/src';
import {
  preferredEngineForLanguages,
  selectLocalEngine,
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
  // Compiled install of the pinned archive: 632,191,599 bytes.
  orukeet: 603 * 1024 * 1024,
};

/** Orukeet's pinned zip, and what its entries extract to (from its central directory). */
const ORUKEET_ARCHIVE_BYTES = 554_985_744;
const ORUKEET_EXTRACTED_BYTES = 632_017_564;

/**
 * Most disk a download needs at once, for the free-space check. Models fetched straight into
 * place peak at their installed size. Orukeet's zip, its extracted packages and the compiled
 * models coexist until its install finishes.
 */
export const LOCAL_MODEL_INSTALL_PEAK_BYTES: Record<LocalModelKey, number> = {
  'whisper-base': LOCAL_MODEL_SIZE_BYTES['whisper-base'],
  'parakeet-v2': LOCAL_MODEL_SIZE_BYTES['parakeet-v2'],
  'parakeet-v3': LOCAL_MODEL_SIZE_BYTES['parakeet-v3'],
  orukeet: ORUKEET_ARCHIVE_BYTES + ORUKEET_EXTRACTED_BYTES + LOCAL_MODEL_SIZE_BYTES.orukeet,
};

const PARAKEET_VERSION_BY_KEY: Record<LocalModelKey, ParakeetVersion | null> = {
  'whisper-base': null,
  'parakeet-v2': 'v2',
  'parakeet-v3': 'v3',
  orukeet: 'orukeet',
};

const KEY_BY_PARAKEET_VERSION: Record<ParakeetVersion, LocalModelKey> = {
  v2: 'parakeet-v2',
  v3: 'parakeet-v3',
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
  /** Dictation in the user's languages runs on this model right now. */
  inUse: boolean;
}

/** The model the user's language selection should download (drives onboarding + recommendations). */
export function recommendedModelKey(languages: readonly string[]): LocalModelKey {
  const preferred = preferredEngineForLanguages(languages);
  if (preferred.engine === 'whisper') return 'whisper-base';
  return KEY_BY_PARAKEET_VERSION[preferred.version];
}

/** The installed model the user's language selection routes to, or null when none is installed. */
function modelKeyInUse(
  languages: readonly string[],
  availability: LocalEngineAvailability,
): LocalModelKey | null {
  const choice = selectLocalEngine(languages, availability);
  if (choice.engine === 'none') return null;
  return choice.engine === 'whisper' ? 'whisper-base' : KEY_BY_PARAKEET_VERSION[choice.version];
}

/**
 * Display rows for the transcription-models screen: all installable engines with the one the
 * user's language selection routes to marked recommended (and listed first). Orukeet is opt-in, so
 * it is never recommended; once downloaded it is the row marked in use. Parakeet-runtime rows are
 * omitted where the native module isn't linked (Android, Expo Go), and Orukeet also where the
 * binary predates it.
 */
export function getLocalModelCatalog(
  languages: readonly string[],
  availability: LocalEngineAvailability,
): LocalModelCatalogEntry[] {
  const recommended = recommendedModelKey(languages);
  const inUse = modelKeyInUse(languages, availability);

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
      inUse: inUse === 'parakeet-v2',
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
      inUse: inUse === 'parakeet-v3',
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
      inUse: inUse === 'orukeet',
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
      inUse: inUse === 'whisper-base',
    },
  ];

  const supported: Record<LocalModelCatalogEntry['engineName'], boolean> = {
    Parakeet: availability.parakeetSupported,
    Orukeet: availability.parakeetSupported && availability.orukeetSupported,
    Whisper: true,
  };
  const visible = entries.filter((entry) => supported[entry.engineName]);

  // Recommended first; otherwise keep the declaration order (stable sort).
  return visible.sort((a, b) => Number(b.recommended) - Number(a.recommended));
}
