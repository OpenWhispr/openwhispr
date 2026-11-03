import * as FileSystem from 'expo-file-system/legacy';
import type { MeetingRecoveryDeps } from './meetingRecovery';

export interface MeetingRecoveryRun {
  directory: string | null;
  isCurrent?: () => boolean;
  listRecordingFiles(): Promise<string[]>;
  getStorage(): MeetingRecoveryDeps['storage'];
}

export function createMeetingRecoveryLifecycle() {
  let hasStarted = false;
  return {
    begin(): MeetingRecoveryRun | null {
      if (hasStarted) return null;
      hasStarted = true;
      const directory = FileSystem.documentDirectory;
      return {
        directory,
        listRecordingFiles: () => FileSystem.readDirectoryAsync(directory!),
        getStorage: () => localStorage,
      };
    },
  };
}
