import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { notesRepository, spacesRepository } from '@/data';
import { fetchFolders } from '@/data/remote/notesApi';
import { EPOCH } from './pullNotes';
import { clearPark, recordPark } from './pullParkTracker';
import { TEAM_FOLDERS_CURSOR_KEY } from './teamCursors';
import type { RemoteFolder } from '@/data';

// Independent of the personal pass's cursor. No id half: /api/folders/list is
// unpaginated, and parking here simply leaves the cursor untouched. The key
// lives in teamCursors.ts because push-side permission recovery resets it.
const CURSOR_KEY = TEAM_FOLDERS_CURSOR_KEY;
const PARKED_ROW_KEY = 'folders.team.parked_row';

/**
 * Rows this pass owns. Everything else is a personal row the personal pass
 * already applied (or will), so it is stepped over here rather than applied
 * twice.
 */
function isTeamRow(remote: RemoteFolder): boolean {
  return (
    remote.space_id != null || remote.previous_space_id != null || remote.access_removed === true
  );
}

/**
 * Redacted stub: the folder left our reach. Stubs carry no fields at all — no
 * name, sort order or tombstone — so nothing may ever be applied from one, and
 * the space they name is by definition one this device can't resolve, so they
 * must never park either. The local row is simply dropped.
 *
 * Only the folder ROW goes: its notes are left untouched on purpose. Each of
 * them arrives as its own stub in the note pass, which knows how to keep
 * unpushed local work (forkNoteToPrivate) instead of destroying it.
 */
function applyAccessRemovedStub(remote: RemoteFolder): void {
  const local = notesRepository.getFolderByRemoteId(remote.id);
  if (local) notesRepository.hardDeleteFolder(local.id);
}

/**
 * Team-scope folder pull: `scope=all` with its own cursor, restricted to rows
 * carrying a space, a previous space, or an access-removed stub.
 *
 * Parking (a space this device hasn't mirrored yet) ends the pass without
 * error and without advancing the cursor at all, so the next sync — whose
 * syncSpaces pass runs first — replays the whole delta. That is cheap and safe
 * here: the list is unpaginated and folder applies are idempotent. A row that
 * parks run after run escalates via pullParkTracker.
 */
export async function pullFoldersTeam(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(CURSOR_KEY);
  // Always send a cursor, epoch when we have none: without `since` the endpoint
  // switches to its browse listing, which filters tombstones out — so a first
  // crawl (or one after resetTeamCursors) would never learn about folders
  // deleted server-side. Mirrors pullNotesTeam's `since ?? EPOCH`.
  checkpoint();
  const remote = await fetchFolders(since ?? EPOCH, 'all');
  checkpoint();
  const privateSpaceId = spacesRepository.getPrivateSpace().id;

  let maxUpdatedAt = since ?? '';
  for (const r of remote) {
    if (isTeamRow(r)) {
      // Stubs are checked before anything else: they carry neither the fields
      // an apply needs nor a space this device could resolve, so any other
      // ordering would insert a nameless row, relocate a live folder into the
      // private space, or park the cursor on a space that never arrives.
      if (r.access_removed) {
        applyAccessRemovedStub(r);
      } else if (r.deleted_at) {
        // Tombstones take the existing delete path and resolve no space: a
        // delete doesn't need one.
        notesRepository.applyRemoteFolder(r);
      } else {
        // space_id null here means previous_space_id is set: the folder moved
        // team → personal, so it lands in this device's private space.
        let spaceId = privateSpaceId;
        if (r.space_id != null) {
          const space = spacesRepository.getByCloudId(r.space_id);
          if (!space) {
            recordPark(
              PARKED_ROW_KEY,
              r.id,
              `team folder pull parked at ${r.id}: unknown space ${r.space_id}`,
            );
            return;
          }
          spaceId = space.id;
        }
        notesRepository.applyRemoteFolder(r, { spaceId });
      }
    }
    if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
  }

  clearPark(PARKED_ROW_KEY);
  if (maxUpdatedAt) notesRepository.setSyncState(CURSOR_KEY, maxUpdatedAt);
}
