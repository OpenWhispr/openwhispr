import { createNoteSharingHook } from './useNoteSharingCore';
import { useAndroidCopy } from './useAndroidCopy';
import { NoteSharingError, noteSharingFeedback } from '@/lib/notes/noteSharingFeedback';

export const INVALID_EMAIL_ERROR = noteSharingFeedback.invalidEmail;
function usePresentation() {
  const { copy } = useAndroidCopy();
  return (error: string | NoteSharingError | null, message: string | NoteSharingError | null) => ({
    error:
      error instanceof NoteSharingError
        ? copy(`noteSharingFeedback.${error.code}`, error.message)
        : error,
    errorCode: error instanceof NoteSharingError ? error.code : null,
    message:
      message instanceof NoteSharingError
        ? copy(`noteSharingFeedback.${message.code}`, message.message)
        : message,
  });
}
export const useNoteSharing = createNoteSharingHook({
  message: (code) => new NoteSharingError(code),
  failure: (code) => new NoteSharingError(code),
  ownedError: (error) => (error instanceof NoteSharingError ? error : undefined),
  usePresentation,
});
export type NoteSharingController = ReturnType<typeof useNoteSharing>;
