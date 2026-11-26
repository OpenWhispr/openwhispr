import { useConfigStore } from '@/android/store/useConfigStore';
import type { UserConfig } from '@/android/types';
import { ANDROID_MODELS, modelReady, modelSupported, type AndroidModelId } from './models';
import { speechModelSupportsLanguages } from './speechCapabilities';

export type AndroidSpeechModelId = NonNullable<UserConfig['androidSpeechModel']>;

/** The phone's speech models, in catalog order, without those this Android version can't run. */
export function speechModels(): AndroidSpeechModelId[] {
  return (Object.keys(ANDROID_MODELS) as AndroidModelId[]).filter(
    (id): id is AndroidSpeechModelId => ANDROID_MODELS[id].kind === 'speech' && modelSupported(id),
  );
}

/** Whether a speech model can transcribe a meeting (word timings over a long recording). */
export function canTranscribeMeetings(id: AndroidModelId): boolean {
  const entry = ANDROID_MODELS[id];
  return entry?.kind === 'speech' && 'meetings' in entry && entry.meetings === true;
}

/** The speech models meetings can use, in catalog order. */
export const meetingSpeechModels = (): AndroidSpeechModelId[] =>
  speechModels().filter(canTranscribeMeetings);

/** What dictation uses when no speech model was picked; the Settings screens show the same. */
export const DEFAULT_SPEECH_MODEL: AndroidSpeechModelId = 'parakeet-v3';

/**
 * The speech model chosen for dictation and uploads. Unset or no longer in the catalog means
 * Parakeet v3, as Settings shows it; the catalog's first only where this phone can't run Parakeet.
 */
export function selectedSpeechModel(): AndroidSpeechModelId {
  const selected = useConfigStore.getState().config?.androidSpeechModel;
  const models = speechModels();
  if (selected && models.includes(selected)) return selected;
  return models.includes(DEFAULT_SPEECH_MODEL)
    ? DEFAULT_SPEECH_MODEL
    : (models[0] ?? DEFAULT_SPEECH_MODEL);
}

/**
 * The model a meeting on the phone transcribes with: the dictation model when it can do
 * meetings, otherwise the first meeting model on the phone, so dictating with an English-only
 * model never stops meetings. Null when no meeting model on the phone covers the languages.
 */
export async function meetingSpeechModel(
  languages?: readonly string[],
): Promise<AndroidSpeechModelId | null> {
  // Loaded here: the languages live in storage that screens importing this file needn't open.
  const wanted =
    languages ??
    (
      require('@/android/shared/lib/transcriptionLanguage') as typeof import('@/android/shared/lib/transcriptionLanguage')
    ).getPreferredTranscriptionLanguages();
  const selected = selectedSpeechModel();
  const candidates = [
    ...(canTranscribeMeetings(selected) ? [selected] : []),
    ...meetingSpeechModels().filter((id) => id !== selected),
  ];
  for (const id of candidates)
    if (speechModelSupportsLanguages(id, wanted) && (await modelReady(id).catch(() => false)))
      return id;
  return null;
}
