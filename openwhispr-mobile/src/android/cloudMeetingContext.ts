import { useAuthStore } from '@/store/useAuthStore';
import { notesRepository } from '@/data';
import { Sentry } from '@/lib/sentry';
import { createLocalMeetingContext } from './localMeetingContext';

export function createCloudMeetingContext(noteId: number, signal?: AbortSignal) {
  const owner = useAuthStore.getState();
  const userId = owner.user?.id;
  const cookie = owner.sessionCookie;
  const savedNote = notesRepository.getNoteById(noteId);
  const originalNote = savedNote ? { ...savedNote } : null;
  const context = createLocalMeetingContext(noteId, signal);
  if (!originalNote || originalNote.isPrivate === 1) return context;
  let recoveryRequested = false;

  // Keep cancellation and private recovery on the unchanged Local context.
  // Only the Android Cloud screen permits public-note sync normalization.
  return {
    ...context,
    recoverInterruptedNoteWhenOwnerReturns(sourceFile: string, recover: () => void) {
      if (recoveryRequested) return;
      recoveryRequested = true;
      let unsubscribe = () => {};
      const attempt = () => {
        const current = useAuthStore.getState();
        if (current.user?.id !== userId) return;
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
            note.isPrivate === 1 ||
            note.clientNoteId !== originalNote.clientNoteId ||
            (!originalNote.clientNoteId &&
              (note.createdAt !== originalNote.createdAt ||
                note.ownerUserId !== originalNote.ownerUserId)) ||
            (note.ownerUserId != null &&
              note.ownerUserId !== originalNote.ownerUserId &&
              note.ownerUserId !== userId) ||
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
  };
}
