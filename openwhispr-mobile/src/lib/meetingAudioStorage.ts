import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

export function meetingAudioContext(): { namespace: string; key: string; isCurrent(): boolean } {
  if (Platform.OS !== 'android') return { namespace: '', key: 'device', isCurrent: () => true };
  const { useAccountData } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  const state = useAccountData.getState();
  if (!state.owner || state.error || state.blocked)
    throw new Error('Local account data is unavailable. Please retry.');
  return {
    namespace: state.audioNamespace,
    key: `account-data:${state.revision}`,
    isCurrent: () => {
      const current = useAccountData.getState();
      return !current.error && !current.blocked && current.revision === state.revision;
    },
  };
}

export function meetingAudioDirectory(namespace = meetingAudioContext().namespace): string | null {
  const root = FileSystem.documentDirectory;
  return root ? `${root}${namespace ? `account-audio/${namespace}/` : ''}` : null;
}
