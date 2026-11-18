import { createEnsureNoteSynced } from './ensureNoteSyncedCore';
import { noteSharingMessages } from '@/lib/notes/noteSharingMessages';

export const NOTE_UNAVAILABLE_ERROR = noteSharingMessages.noteUnavailable;
export const NOTE_PRIVATE_ERROR = noteSharingMessages.notePrivate;
export const ensureNoteSynced = createEnsureNoteSynced({
  failure: (code) => new Error(noteSharingMessages[code]),
  isCloudBackupEnabled: (config) => config?.cloudBackupEnabled !== false,
});
