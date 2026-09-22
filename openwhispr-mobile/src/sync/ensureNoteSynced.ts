import { notesRepository, spacesRepository, type Note } from '@/data';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore } from '@/store/useNotesStore';
import { requestSync, subscribeSyncCompletion } from './syncEngine';
import { useSyncStore } from './useSyncStore';

function readPublishableNote(noteId: number): Note {
  const note = notesRepository.getNoteById(noteId);
  if (
    !note ||
    note.deletedAt ||
    notesRepository.isRemoteNoteHeldByFolderDelete({
      id: note.remoteId ?? '',
      client_note_id: note.clientNoteId,
    })
  )
    throw new Error('This note is no longer available.');
  if (note.isPrivate === 1) throw new Error('Enable cloud sync for this note before sharing.');
  if (note.conflictServerNote) throw new Error('Resolve this note’s sync conflict before sharing.');
  return note;
}

/** Wait for the existing sync pipeline to acknowledge this note's latest edits. */
export async function ensureNoteSynced(
  noteId: number,
  {
    signal,
    timeoutMs = 30_000,
    minCloudUpdatedAt,
  }: {
    signal: AbortSignal;
    timeoutMs?: number;
    minCloudUpdatedAt?: string;
  },
): Promise<string> {
  const auth = useAuthStore.getState();
  if (!auth.user || auth.user.isAnonymous || auth.isGuest || auth.isLoading) {
    throw new Error('Sign in to an account before sharing.');
  }
  if (signal.aborted) throw new Error('Sharing cancelled.');
  const original = readPublishableNote(noteId);
  const isTeamNote = spacesRepository
    .listSpaces()
    .some((space) => space.id === original.spaceId && space.kind === 'team');

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let completedPass = false;
    const unsubscribe: Array<() => void> = [];
    const finish = (value: string | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      unsubscribe.forEach((stop) => stop());
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const cancel = (): void => finish(new Error('Sharing cancelled.'));
    const timer = setTimeout(
      () =>
        finish(
          new Error('The note has not finished syncing. Check your connection and try again.'),
        ),
      timeoutMs,
    );
    const inspect = (): void => {
      try {
        const current = useAuthStore.getState();
        if (
          current.user?.id !== auth.user?.id ||
          current.sessionCookie !== auth.sessionCookie ||
          current.isLoading ||
          current.isGuest
        )
          throw new Error('Your account changed. Open sharing again.');
        const note = readPublishableNote(noteId);
        if (
          note.clientNoteId !== original.clientNoteId ||
          (original.remoteId && note.remoteId !== original.remoteId)
        )
          throw new Error('This note’s cloud identity changed. Open sharing again.');
        if (!isTeamNote && useConfigStore.getState().config?.cloudBackupEnabled === false) {
          throw new Error('Enable cloud backup in Preferences before sharing.');
        }
        if (!completedPass) return;
        if (note.remoteId && !note.pendingSync && !notesRepository.hasDirtyTranscript(noteId)) {
          if (notesRepository.getSyncState(`note.pushRejected.${noteId}`)) {
            throw new Error(
              'The latest changes were rejected by sync. Edit the note and retry before sharing.',
            );
          }
          // The share timestamp is only a pull target, never a content acknowledgement.
          if (
            !minCloudUpdatedAt ||
            (note.cloudUpdatedAt &&
              (note.cloudUpdatedAt === minCloudUpdatedAt ||
                Date.parse(note.cloudUpdatedAt) > Date.parse(minCloudUpdatedAt)))
          ) {
            finish(note.remoteId);
            return;
          }
        }
        const sync = useSyncStore.getState();
        if (sync.policyBlocked) throw new Error('Your organization does not allow cloud backup.');
        if (!isTeamNote && sync.subscriptionRequired) {
          throw new Error('An active subscription is required to sync this note.');
        }
        if (sync.lastError)
          throw new Error('Unable to sync this note. Check your connection and try again.');
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Unable to sync this note.'));
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    unsubscribe.push(
      useAuthStore.subscribe(inspect),
      useNotesStore.subscribe(inspect),
      useConfigStore.subscribe(inspect),
      subscribeSyncCompletion((hasQueuedRun): void => {
        completedPass = !hasQueuedRun;
        inspect();
      }),
    );
    inspect();
    if (!settled) requestSync('manual');
  });
}
