import { createNoteSharingHook } from './useNoteSharingCore';
import { noteSharingMessages } from '@/lib/notes/noteSharingMessages';

export const INVALID_EMAIL_ERROR = noteSharingMessages.invalidEmail;
const present = (error: string | null, message: string | null) => ({ error, message });
function usePresentation() {
  return present;
}

export const useNoteSharing = createNoteSharingHook({
  message: (code) => noteSharingMessages[code],
  failure: (code) => new Error(noteSharingMessages[code]),
  usePresentation,
});
export type NoteSharingController = ReturnType<typeof useNoteSharing>;
