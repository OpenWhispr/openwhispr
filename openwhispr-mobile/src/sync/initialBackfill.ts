import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { notesRepository, spacesRepository } from '@/data';
import { fetchFolders } from '@/data/remote/notesApi';
import { randomUUID } from '@/lib/uuid';

const FLAG_PREFIX = 'initial_backfill_done.';

export async function runInitialBackfillIfNeeded(
  userId: string,
  checkpoint: SyncCheckpoint = uncheckedSync,
): Promise<void> {
  checkpoint();
  const flagKey = `${FLAG_PREFIX}${userId}`;
  if (notesRepository.getSyncState(flagKey) === '1') {
    // migrate.ts re-seeds the default folders on every launch, so one can come back after
    // this ran: once an account switch has wiped the folders, or another device deleted
    // one. Without a client id it never uploads and its notes never get a folder on the
    // server. pushFolders adopts it into a synced same-named default rather than creating
    // a second one. A folder the server already has is left alone: queued, it would push
    // its local name back over a rename made on another device.
    for (const folder of notesRepository.getFoldersMissingClientId()) {
      if (folder.remoteId || folder.deletedAt) continue;
      notesRepository.setFolderClientId(folder.id, randomUUID());
    }
    return;
  }

  // fetchFolders(null) carries no scope param, so this is already a
  // private-scope-only snapshot — see fetchFolders' scope doc.
  checkpoint();
  const remoteFolders = await fetchFolders(null);
  checkpoint();
  const remoteByName = new Map(remoteFolders.map((f) => [f.name.toLowerCase(), f]));
  const privateSpaceId = spacesRepository.getPrivateSpace().id;

  for (const local of notesRepository.getFoldersMissingClientId()) {
    const isDefault = (local.isDefault ?? 0) === 1;
    // Name-based adoption is private-scope only: a team folder is matched by
    // cloud id instead (see pullFoldersTeam.ts), so matching by name here
    // could mis-adopt an unrelated team folder that happens to share a
    // private default folder's name.
    const isPrivateSpaceFolder = local.spaceId === privateSpaceId;
    const match = isPrivateSpaceFolder ? remoteByName.get(local.name.toLowerCase()) : undefined;
    if (isDefault && match && match.is_default) {
      notesRepository.setFolderClientId(local.id, match.client_folder_id ?? randomUUID());
      notesRepository.markFolderPushed(local.id, match.id, match.updated_at);
      continue;
    }
    notesRepository.setFolderClientId(local.id, randomUUID());
  }

  for (const n of notesRepository.getNotesMissingClientId()) {
    notesRepository.setNoteClientId(n.id, randomUUID());
  }

  notesRepository.setSyncState(flagKey, '1');
}
