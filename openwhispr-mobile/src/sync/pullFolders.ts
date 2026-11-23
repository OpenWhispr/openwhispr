import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { notesRepository } from '@/data';
import { fetchFolders } from '@/data/remote/notesApi';
import { FOLDERS_CURSOR_KEY } from './pullCursors';
import { EPOCH } from './pullNotes';

export async function pullFolders(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(FOLDERS_CURSOR_KEY);
  checkpoint();
  // An absent cursor must replay deletions too; the API's browse listing omits tombstones.
  const remote = await fetchFolders(since ?? EPOCH);
  checkpoint();

  let maxUpdatedAt = since ?? '';
  for (const r of remote) {
    notesRepository.applyRemoteFolder(r);
    if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
  }

  if (maxUpdatedAt) notesRepository.setSyncState(FOLDERS_CURSOR_KEY, maxUpdatedAt);
}
