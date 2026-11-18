import { useConfigStore } from '@/store/useConfigStore';
import type { UserConfig } from '@/types';

export type AndroidSpeechModelId = NonNullable<UserConfig['androidSpeechModel']>;
export function selectedSpeechModel(): AndroidSpeechModelId {
  const selected = useConfigStore.getState().config?.androidSpeechModel;
  return selected === 'moonshine-tiny' || selected === 'moonshine-small' ? selected : 'parakeet-v3';
}
