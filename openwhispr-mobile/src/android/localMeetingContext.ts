import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { notesRepository } from '@/data';
import { Sentry } from '@/lib/sentry';

/** Observe transitions, including A -> B -> A, for the whole asynchronous job. */
export function createLocalMeetingContext(noteId: number, signal?: AbortSignal) {
  const owner = useAuthStore.getState();
  const userId = owner.user?.id;
  const cookie = owner.sessionCookie;
  const mode = useProcessingModeStore.getState().activeMode;
  const savedNote = notesRepository.getNoteById(noteId);
  const originalNote = savedNote ? { ...savedNote } : null;
  const privateNote = originalNote?.isPrivate === 1;
  let invalidated = false;
  let identityInvalidated = false;
  let disposed = false;
  let recoveryRequested = false;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const identityMatches = () => {
    const current = useAuthStore.getState();
    return current.user?.id === userId && current.sessionCookie === cookie;
  };
  const unsubscribeAuth = useAuthStore.subscribe(() => {
    if (!identityMatches()) {
      identityInvalidated = true;
      invalidated = true;
      cancel();
    }
  });
  const unsubscribeMode = useProcessingModeStore.subscribe((state) => {
    if (state.activeMode !== mode) {
      invalidated = true;
      cancel();
    }
  });
  // Only for retaining audio / marking an interrupted recording retryable.
  // A mode change stops processing but does not transfer ownership of the saved note.
  const ownsSavedNote = () => {
    if (disposed || identityInvalidated || !identityMatches()) return false;
    const note = notesRepository.getNoteById(noteId);
    return (
      !!note &&
      !note.deletedAt &&
      note.noteType === 'meeting' &&
      (note.isPrivate === 1) === privateNote
    );
  };
  return {
    signal: controller.signal,
    ownsSavedNote,
    // A stopped recording may outlive its screen/account. This one-shot recovery
    // only restores Retry; it never revives the invalidated processing context.
    // Call after native Stop settles, including when this context is disposed.
    recoverInterruptedNoteWhenOwnerReturns(sourceFile: string, recover: () => void) {
      if (recoveryRequested || !originalNote || !privateNote) return;
      recoveryRequested = true;
      let unsubscribe = () => {};
      const attempt = () => {
        const current = useAuthStore.getState();
        if (current.user?.id !== userId) return;
        // With no account ID, only the original local guest session is an owner.
        if (
          userId == null &&
          (current.sessionCookie !== cookie || current.isGuest !== owner.isGuest)
        )
          return;
        unsubscribe();
        try {
          const note = notesRepository.getNoteById(noteId);
          if (
            !note ||
            note.deletedAt ||
            note.noteType !== 'meeting' ||
            note.isPrivate !== 1 ||
            note.clientNoteId !== originalNote.clientNoteId ||
            note.createdAt !== originalNote.createdAt ||
            note.ownerUserId !== originalNote.ownerUserId ||
            note.sourceFile !== sourceFile
          )
            return;
          recover();
        } catch (error) {
          Sentry.captureException(error);
        }
      };
      unsubscribe = useAuthStore.subscribe(attempt);
      attempt();
    },
    ownsNote: () =>
      !invalidated && useProcessingModeStore.getState().activeMode === mode && ownsSavedNote(),
    checkpoint() {
      if (
        invalidated ||
        useProcessingModeStore.getState().activeMode !== mode ||
        !ownsSavedNote() ||
        controller.signal.aborted
      ) {
        throw Object.assign(new Error('Meeting processing cancelled.'), { name: 'AbortError' });
      }
    },
    dispose() {
      disposed = true;
      signal?.removeEventListener('abort', cancel);
      unsubscribeAuth();
      unsubscribeMode();
    },
  };
}
