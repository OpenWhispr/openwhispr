import { notesRepository, type Note, type RemoteNote } from '@/data';
import { deleteNote, fetchNotes } from '@/data/remote/notesApi';
import { useAuthStore } from '@/store/useAuthStore';
import { EPOCH, PAGE_SIZE } from './pullNotes';
import { SyncCancelledError, uncheckedSync, type SyncCheckpoint } from './syncContext';
import {
  clearNoteCreateAttempts,
  forgetNoteCreateAttempts,
  mayHaveCloudCopy,
} from './noteCreateAttempts';

const QUEUE_KEY = 'notes.private_deletion_queue';

type CloudIdentity = Pick<Note, 'remoteId' | 'clientNoteId'>;
type FindRemoteNote = (identity: CloudIdentity) => Promise<RemoteNote | undefined>;
const inFlightDeletes = new Map<string, Promise<void>>();

function sameCloudCopy(left: CloudIdentity, right: CloudIdentity): boolean {
  if (left.remoteId && right.remoteId) return left.remoteId === right.remoteId;
  return Boolean(left.clientNoteId && left.clientNoteId === right.clientNoteId);
}

function readQueue(): CloudIdentity[] {
  const stored = notesRepository.getSyncState(QUEUE_KEY);
  return stored ? (JSON.parse(stored) as CloudIdentity[]) : [];
}

function writeQueue(identities: CloudIdentity[]): void {
  if (identities.length) notesRepository.setSyncState(QUEUE_KEY, JSON.stringify(identities));
  else notesRepository.clearSyncState(QUEUE_KEY);
}

// Persist before publication rotates the local identity, including creates whose
// server response was lost. The retired copy remains removable after relaunch.
export function queuePrivateNoteDeletion(note: CloudIdentity): void {
  if (!mayHaveCloudCopy(note)) return;
  const queue = readQueue();
  if (queue.some((identity) => sameCloudCopy(identity, note))) return;
  writeQueue([...queue, { remoteId: note.remoteId, clientNoteId: note.clientNoteId }]);
}

export function clearPrivateNoteDeletionQueue(): void {
  notesRepository.clearSyncState(QUEUE_KEY);
  clearNoteCreateAttempts();
}

function completeIdentity(identity: CloudIdentity): void {
  writeQueue(readQueue().filter((queued) => !sameCloudCopy(queued, identity)));
  if (identity.clientNoteId) forgetNoteCreateAttempts([identity.clientNoteId]);
}

function createRemoteLookup(checkpoint: SyncCheckpoint): FindRemoteNote {
  let crawl: Promise<RemoteNote[]> | undefined;
  async function readRemoteNotes(): Promise<RemoteNote[]> {
    const result: RemoteNote[] = [];
    let since = EPOCH;
    let sinceId: string | undefined;
    while (true) {
      checkpoint();
      // A separate epoch crawl includes tombstones without importing content or
      // advancing the content-sync cursors, even with personal backup disabled.
      const page = await fetchNotes({ since, sinceId, limit: PAGE_SIZE, scope: 'all' });
      checkpoint();
      result.push(...page.notes);
      if (page.notes.length < PAGE_SIZE || page.hasMore === false) return result;
      const last = page.notes[page.notes.length - 1];
      since = last.updated_at;
      sinceId = last.id;
    }
  }
  return async (identity): Promise<RemoteNote | undefined> => {
    crawl ??= readRemoteNotes();
    const notes = await crawl;
    checkpoint();
    return notes.find((remote) =>
      identity.remoteId
        ? remote.id === identity.remoteId
        : remote.client_note_id === identity.clientNoteId,
    );
  };
}

function deleteRemoteOnce(remoteId: string): Promise<void> {
  const { user, sessionCookie } = useAuthStore.getState();
  const key = JSON.stringify([user?.id, sessionCookie, remoteId]);
  const existing = inFlightDeletes.get(key);
  if (existing) return existing;
  // Share only the network request: each caller must check its own context and
  // local identity after completion, including callers in different auth runs.
  const request = deleteNote(remoteId).finally(() => {
    if (inFlightDeletes.get(key) === request) inFlightDeletes.delete(key);
  });
  inFlightDeletes.set(key, request);
  return request;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

async function removeCloudCopy(
  identity: CloudIdentity,
  findRemote: FindRemoteNote,
  checkpoint: SyncCheckpoint,
): Promise<string> {
  checkpoint();
  let remoteId = identity.remoteId;
  if (!remoteId) {
    const remote = await findRemote(identity);
    if (!remote || remote.access_removed) throw new Error('Cloud copy removal is pending');
    if (remote.deleted_at) return remote.id;
    remoteId = remote.id;
  }
  try {
    checkpoint();
    await deleteRemoteOnce(remoteId);
    checkpoint();
  } catch (error) {
    checkpoint();
    if (!isNotFound(error)) throw error;
    const remote = await findRemote({ ...identity, remoteId });
    // Absence and revoked-access stubs cannot distinguish deletion from lost
    // permission. Only an actual tombstone proves the old copy is gone.
    if (!remote?.deleted_at || remote.access_removed) throw error;
  }
  checkpoint();
  return remoteId;
}

async function cleanIdentity(
  identity: CloudIdentity,
  local: Note | undefined,
  findRemote: FindRemoteNote,
  checkpoint: SyncCheckpoint,
): Promise<void> {
  checkpoint();
  const before = local ? notesRepository.getNoteById(local.id) : null;
  const queued = readQueue().some((entry) => sameCloudCopy(entry, identity));
  if (!queued && (!before || before.isPrivate !== 1 || !sameCloudCopy(before, identity))) return;
  let remoteId: string;
  try {
    remoteId = await removeCloudCopy(identity, findRemote, checkpoint);
  } catch (error) {
    checkpoint();
    const current = local ? notesRepository.getNoteById(local.id) : null;
    const stillQueued = readQueue().some((entry) => sameCloudCopy(entry, identity));
    if (
      !stillQueued &&
      (!current || current.isPrivate !== 1 || !sameCloudCopy(current, identity))
    ) {
      return;
    }
    throw error;
  }
  checkpoint();
  if (local) {
    const current = notesRepository.getNoteById(local.id);
    if (
      current?.isPrivate === 1 &&
      current.clientNoteId === local.clientNoteId &&
      (current.remoteId === local.remoteId || current.remoteId === remoteId)
    ) {
      notesRepository.clearNoteRemoteId(local.id);
      notesRepository.clearNoteClientId(local.id);
    }
  }
  completeIdentity(identity);
}

export async function deletePrivateNoteCloudCopy(
  note: Note,
  checkpoint: SyncCheckpoint = uncheckedSync,
): Promise<void> {
  if (note.isPrivate !== 1 || !mayHaveCloudCopy(note)) return;
  checkpoint();
  await cleanIdentity(note, note, createRemoteLookup(checkpoint), checkpoint);
}

// Cleanup sends no content and must remain available with cloud backup disabled.
export async function pushPrivateNoteDeletes(
  checkpoint: SyncCheckpoint = uncheckedSync,
): Promise<void> {
  checkpoint();
  const pending: Array<{ identity: CloudIdentity; local?: Note }> = notesRepository
    .getPrivateNotesPendingDeletion()
    .filter(mayHaveCloudCopy)
    .map((local) => ({ identity: local, local }));
  for (const identity of readQueue()) {
    if (!pending.some((entry) => sameCloudCopy(entry.identity, identity)))
      pending.push({ identity });
  }
  const findRemote = createRemoteLookup(checkpoint);
  let firstError: unknown;
  for (const { identity, local } of pending) {
    try {
      await cleanIdentity(identity, local, findRemote, checkpoint);
    } catch (error) {
      checkpoint();
      if (error instanceof SyncCancelledError) throw error;
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}
