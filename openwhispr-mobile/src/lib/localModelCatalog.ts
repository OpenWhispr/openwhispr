import {
  preferredEngineForLanguages,
  type LocalEngineAvailability,
} from '@/services/transcription/localEngine';

export type LocalModelKey = 'whisper-base' | 'parakeet-v2' | 'parakeet-v3';

/**
 * Nominal on-disk sizes shown before download (whisper from its published ggml size; Parakeet
 * measured on-device by the benchmark spike). Used for display and the pre-download
 * free-space check — close enough is fine.
 */
export const LOCAL_MODEL_SIZE_BYTES: Record<LocalModelKey, number> = {
  'whisper-base': 142 * 1024 * 1024,
  'parakeet-v2': 443 * 1024 * 1024,
  'parakeet-v3': 461 * 1024 * 1024,
};

export interface LocalModelCatalogEntry {
  key: LocalModelKey;
  engineName: 'Parakeet' | 'Whisper';
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
 * user's language selection routes to marked recommended (and listed first). Parakeet rows are
 * omitted where the native module isn't linked (Android, Expo Go).
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
    : entries.filter((entry) => entry.engineName !== 'Parakeet');

  // Recommended first; otherwise keep the declaration order (stable sort).
  return visible.sort((a, b) => Number(b.recommended) - Number(a.recommended));
}
