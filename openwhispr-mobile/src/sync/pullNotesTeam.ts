import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { notesRepository, spacesRepository } from '@/data';
import { fetchNotes } from '@/data/remote/notesApi';
import { EPOCH, PAGE_SIZE } from './pullNotes';
import { clearPark, recordPark } from './pullParkTracker';
import { TEAM_NOTES_CURSOR_ID_KEY, TEAM_NOTES_CURSOR_KEY } from './teamCursors';
import type { RemoteNote } from '@/data';

// Independent of the personal pass's cursors — the two crawls never couple.
// The id half is what makes parking safe: resuming from (updated_at, id) puts
// the parked row back at the head of the next page even when several rows
// share a timestamp. Both keys live in teamCursors.ts because push-side
// permission recovery resets them.
const CURSOR_KEY = TEAM_NOTES_CURSOR_KEY;
const CURSOR_ID_KEY = TEAM_NOTES_CURSOR_ID_KEY;
const PARKED_ROW_KEY = 'notes.team.parked_row';

/**
 * Rows this pass owns. Everything else in a `scope=all` response is a personal
 * row that the personal pass already applied (or will), so it is stepped over
 * here rather than applied twice.
 */
function isTeamRow(remote: RemoteNote): boolean {
  return (
    remote.space_id != null || remote.previous_space_id != null || remote.access_removed === true
  );
}

/**
 * Redacted stub: the note left our reach. Stubs carry no content, so nothing
 * is ever applied from them — the local row is either dropped or forked.
 */
function applyAccessRemovedStub(remote: RemoteNote): void {
  const local = notesRepository.getNoteForRemote(remote);
  // Nothing local to reconcile, or a locally-private row the server has no
  // authority over (same invariant applyRemoteNote enforces).
  if (!local || local.isPrivate === 1) return;

  // "Dirty" has to mean exactly what getPendingNotes means by it: a note whose
  // only unpushed work is edited transcript segments/speakers still has work
  // to lose, and hardDeleteNote would take the audio file with it.
  const dirty = local.pendingSync === 1 || notesRepository.hasDirtyTranscript(local.id);
  // Unpushed local work survives as a fresh personal note. A row already
  // soft-deleted locally is excluded: the user's delete is the newer intent,
  // and forking it would resurrect a note they threw away.
  if (dirty && local.deletedAt == null) {
    notesRepository.forkNoteToPrivate(local.id);
    return;
  }
  notesRepository.hardDeleteNote(local.id);
}

interface TeamRowContext {
  privateSpaceId: number;
  folderMap: Map<string, number>;
  resolveFolder: (serverFolderId: string | null) => number | null;
}

/** The park reason when the row can't be applied yet, else null. */
function applyTeamNote(remote: RemoteNote, ctx: TeamRowContext): string | null {
  // A pending folder delete owns this note until the server rules on it. Skipped
  // ahead of the stub and tombstone branches too: forking or hard-deleting it
  // here would destroy the row revertFolderDelete has to put back.
  if (notesRepository.isRemoteNoteHeldByFolderDelete(remote)) return null;

  if (remote.access_removed) {
    applyAccessRemovedStub(remote);
    return null;
  }

  // Tombstones resolve no space on purpose: a delete doesn't need one, and
  // parking on a row we could have applied would stall the crawl for nothing.
  if (remote.deleted_at) {
    notesRepository.applyRemoteNote(remote, ctx.resolveFolder);
    return null;
  }

  // space_id null here means previous_space_id is set (isTeamRow guarantees
  // one of them): the note moved team → personal, so it lands in this
  // device's private space under the usual last-write-wins rules.
  let spaceId = ctx.privateSpaceId;
  if (remote.space_id != null) {
    const space = spacesRepository.getByCloudId(remote.space_id);
    if (!space) return `unknown space ${remote.space_id}`;
    spaceId = space.id;
  }

  // Folder pulls run before note pulls, so a missing folder is a race, not the
  // norm. Filing to no folder would stick (the cursor never re-delivers this
  // row), so park until the folder arrives.
  if (remote.folder_id && !ctx.folderMap.has(remote.folder_id)) {
    return `unknown folder ${remote.folder_id}`;
  }

  notesRepository.applyRemoteNote(remote, ctx.resolveFolder, { spaceId, applyOwnership: true });
  return null;
}

/**
 * Team-scope note pull: same epoch-based composite-cursor crawl as the personal
 * pass, over `scope=all`, restricted to rows carrying a space, a previous
 * space, or an access-removed stub.
 *
 * Parking is a normal (non-error) completion: when a row needs a space or
 * folder this device hasn't mirrored yet, the crawl stops advancing there and
 * the cursor is left on the last row that was actually finished, so the next
 * sync — whose syncSpaces/pullFolders passes run first — re-delivers the
 * parked row. Access-removed stubs behind a park are still drained (see the
 * loop below); a row that parks run after run escalates via pullParkTracker.
 */
export async function pullNotesTeam(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(CURSOR_KEY);
  const sinceId = notesRepository.getSyncState(CURSOR_ID_KEY);

  // Soft-deleted folders are deliberately included: the local row still exists
  // with a usable id, and applying into a folder whose delete hasn't pushed yet
  // is a coherent transient state (the server tombstones the contained notes
  // when it does push, and those tombstones flow back here). Resolving against
  // getFolders() instead would park every note filed there — forever, since
  // nothing about a soft-deleted folder resolves itself.
  const folderMap = new Map<string, number>();
  for (const f of notesRepository.getFoldersIncludingDeleted()) {
    if (f.remoteId) folderMap.set(f.remoteId, f.id);
  }
  const ctx: TeamRowContext = {
    privateSpaceId: spacesRepository.getPrivateSpace().id,
    folderMap,
    resolveFolder: (serverFolderId: string | null): number | null =>
      serverFolderId ? (folderMap.get(serverFolderId) ?? null) : null,
  };

  let cursor = since ?? EPOCH;
  let cursorId = sinceId ?? undefined;
  let processed: { updatedAt: string; id: string } | null = null;
  let parkedRow: { id: string; reason: string } | null = null;

  while (true) {
    checkpoint();
    const { notes: remoteNotes, hasMore } = await fetchNotes({
      since: cursor,
      sinceId: cursorId,
      limit: PAGE_SIZE,
      scope: 'all',
    });
    checkpoint();

    for (const remote of remoteNotes) {
      if (parkedRow) {
        // Behind the park the cursor is frozen, so nothing here may be applied
        // — the next run replays it all. Stubs are the exception: they can't
        // park (no space or folder to resolve), re-processing one is a no-op,
        // and holding them back would leave content the user has lost access
        // to sitting on the device for as long as the park lasts.
        if (remote.access_removed) applyAccessRemovedStub(remote);
        continue;
      }
      if (!isTeamRow(remote)) {
        processed = { updatedAt: remote.updated_at, id: remote.id };
        continue;
      }
      const reason = applyTeamNote(remote, ctx);
      if (reason !== null) {
        parkedRow = { id: remote.id, reason };
        continue;
      }
      processed = { updatedAt: remote.updated_at, id: remote.id };
    }
    if (parkedRow) break;

    // A short page always means done; hasMore saves one request when the
    // total is an exact multiple of the page size.
    if (remoteNotes.length < PAGE_SIZE || hasMore === false) break;
    const last = remoteNotes[remoteNotes.length - 1];
    cursor = last.updated_at;
    cursorId = last.id;
  }

  if (parkedRow) {
    recordPark(
      PARKED_ROW_KEY,
      parkedRow.id,
      `team note pull parked at ${parkedRow.id}: ${parkedRow.reason}`,
    );
  } else {
    clearPark(PARKED_ROW_KEY);
  }

  if (processed) {
    notesRepository.setSyncState(CURSOR_KEY, processed.updatedAt);
    notesRepository.setSyncState(CURSOR_ID_KEY, processed.id);
  }
}
