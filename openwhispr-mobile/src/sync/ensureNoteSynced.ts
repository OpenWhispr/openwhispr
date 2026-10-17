import { NoteSharingError, noteSharingFeedback } from '@/lib/notes/noteSharingFeedback';
import * as Network from 'expo-network';
import { notesRepository, type Note } from '@/data';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useNotesStore } from '@/store/useNotesStore';
import { isFolderAwaitingUpload } from '@/lib/notes/folderUpload';
import { createPushScopeResolver, createTeamSpaceFilter } from './pushScope';
import { requestSync, subscribeSyncCompletion } from './syncEngine';
import { useSyncStore } from './useSyncStore';

export const NOTE_UNAVAILABLE_ERROR = noteSharingFeedback.noteUnavailable;
export const NOTE_PRIVATE_ERROR = noteSharingFeedback.notePrivate;

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
    throw new NoteSharingError('noteUnavailable');
  if (note.isPrivate === 1) throw new NoteSharingError('notePrivate');
  if (note.conflictServerNote) throw new NoteSharingError('syncConflict');
  return note;
}

/** Wait for the existing sync pipeline to acknowledge this note's latest edits. */
export async function ensureNoteSynced(
  noteId: number,
  { signal, timeoutMs = 30_000 }: { signal: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const auth = useAuthStore.getState();
  if (!auth.user || auth.user.isAnonymous || auth.isGuest || auth.isLoading) {
    throw new NoteSharingError('signInBefore');
  }
  if (signal.aborted) throw new NoteSharingError('cancelled');
  const original = readPublishableNote(noteId);
  const isTeamNote = createTeamSpaceFilter()(original.spaceId);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let completedPass = false;
    let passes = 0;
    let offline = false;
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
    const cancel = (): void => finish(new NoteSharingError('cancelled'));
    const timer = setTimeout(() => finish(new NoteSharingError('syncPending')), timeoutMs);
    const inspect = (): void => {
      try {
        const current = useAuthStore.getState();
        if (
          current.user?.id !== auth.user?.id ||
          current.sessionCookie !== auth.sessionCookie ||
          current.isLoading ||
          current.isGuest
        )
          throw new NoteSharingError('accountChanged');
        const note = readPublishableNote(noteId);
        if (
          note.clientNoteId !== original.clientNoteId ||
          (original.remoteId && note.remoteId !== original.remoteId)
        )
          throw new NoteSharingError('noteChanged');
        if (!isTeamNote && useConfigStore.getState().config?.cloudBackupEnabled === false) {
          throw new NoteSharingError('backupDisabled');
        }
        // Acknowledgement is repository state: a push clears pendingSync only when the server
        // accepted this exact snapshot, terminal rejections leave a flag, and conflicts or privacy
        // changes are rejected above. It needs no completed pass to observe.
        if (!note.pendingSync) {
          const dirtyTranscript = notesRepository.hasDirtyTranscript(noteId);
          // A rejected create settles with no remote ID, so check before requiring one. A rejection
          // also leaves transcript rows dirty; with those, judge it once a pass has retried them.
          if (notesRepository.isNotePushRejected(noteId) && (!dirtyTranscript || completedPass)) {
            throw new NoteSharingError('syncRejected');
          }
          if (note.remoteId && !dirtyTranscript) {
            finish(note.remoteId);
            return;
          }
        }
        // Sync status only reflects this request once a pass has finished with nothing queued.
        if (!completedPass) return;
        if (offline) throw new NoteSharingError('offline');
        const sync = useSyncStore.getState();
        if (sync.policyBlocked) throw new NoteSharingError('backupPolicy');
        // The subscription check fails closed, so an unreachable server also reads as unsubscribed.
        if (sync.lastError) throw new NoteSharingError('syncConnection');
        if (!isTeamNote && sync.subscriptionRequired) {
          throw new NoteSharingError('subscription');
        }
        // The same test pushNotes uses to leave a row queued until its space resolves.
        if (!createPushScopeResolver()(note.spaceId)) {
          throw new NoteSharingError('spacePending');
        }
        // Likewise for a folder that hasn't reached the server yet.
        const folder = notesRepository.getFolders().find(({ id }) => id === note.folderId);
        if (isFolderAwaitingUpload(folder)) {
          throw new NoteSharingError('folderPending');
        }
      } catch (error) {
        finish(error instanceof Error ? error : new NoteSharingError('syncFailed'));
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    unsubscribe.push(
      useAuthStore.subscribe(inspect),
      useNotesStore.subscribe(inspect),
      useConfigStore.subscribe(inspect),
      subscribeSyncCompletion((hasQueuedRun): void => {
        const pass = ++passes;
        completedPass = false;
        if (hasQueuedRun) {
          inspect();
          return;
        }
        // Offline passes end quietly or read as a missing subscription, so the pass only counts
        // once the OS has answered; a newer pass supersedes a slower answer.
        Network.getNetworkStateAsync()
          .then(
            (network) => network.isConnected === false,
            () => false,
          )
          .then((isOffline) => {
            if (pass !== passes) return;
            offline = isOffline;
            completedPass = true;
            inspect();
          });
      }),
    );
    inspect();
    if (!settled) requestSync('manual');
  });
}
