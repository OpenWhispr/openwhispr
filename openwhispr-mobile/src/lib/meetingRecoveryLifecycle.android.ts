import * as FileSystem from 'expo-file-system/legacy';
import { meetingAudioContext, meetingAudioDirectory } from './meetingAudioStorage';
import type { MeetingRecoveryRun } from './meetingRecoveryLifecycle';

export function createMeetingRecoveryLifecycle() {
  const started = new Set<string>();
  return {
    begin(): MeetingRecoveryRun | null {
      const audio = meetingAudioContext();
      if (started.has(audio.key)) return null;
      started.add(audio.key);
      const directory = meetingAudioDirectory(audio.namespace);
      return {
        directory,
        isCurrent: audio.isCurrent,
        listRecordingFiles: async () => {
          const info = await FileSystem.getInfoAsync(directory!);
          return info.exists ? FileSystem.readDirectoryAsync(directory!) : [];
        },
        getStorage: () => {
          const storageKey = (key: string) =>
            audio.namespace ? `account-audio:${audio.namespace}:${key}` : key;
          return {
            getItem: (key) => localStorage.getItem(storageKey(key)),
            setItem: (key, value) => localStorage.setItem(storageKey(key), value),
            removeItem: (key) => localStorage.removeItem(storageKey(key)),
          };
        },
      };
    },
  };
}
