import { createEnsureNoteSynced } from './ensureNoteSyncedCore';
import { isCloudBackupEnabled } from '@/lib/cloudBackup';
import { NoteSharingError, noteSharingFeedback } from '@/lib/notes/noteSharingFeedback';

export const NOTE_UNAVAILABLE_ERROR = noteSharingFeedback.noteUnavailable;
export const NOTE_PRIVATE_ERROR = noteSharingFeedback.notePrivate;
export const ensureNoteSynced = createEnsureNoteSynced({
  failure: (code) => new NoteSharingError(code),
  isCloudBackupEnabled: (config) => isCloudBackupEnabled(config),
});
