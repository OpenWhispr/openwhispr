import { useConfigStore } from '@/store/useConfigStore';
import type { UserConfig } from '@/types';
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

/** The speech model chosen for dictation and uploads; the catalog's first when none is set. */
export function selectedSpeechModel(): AndroidSpeechModelId {
  const selected = useConfigStore.getState().config?.androidSpeechModel;
  const models = speechModels();
  return selected && models.includes(selected) ? selected : (models[0] ?? 'parakeet-v3');
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
      require('@/lib/transcriptionLanguage') as typeof import('@/lib/transcriptionLanguage')
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
