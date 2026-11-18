import * as FileSystem from 'expo-file-system/legacy';

export function meetingAudioContext(): { namespace: string; key: string; isCurrent(): boolean } {
  return { namespace: '', key: 'device', isCurrent: () => true };
}

export function meetingAudioDirectory(namespace = meetingAudioContext().namespace): string | null {
  const root = FileSystem.documentDirectory;
  return root ? `${root}${namespace ? `account-audio/${namespace}/` : ''}` : null;
}
