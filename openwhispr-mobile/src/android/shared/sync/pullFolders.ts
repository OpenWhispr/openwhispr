import { uncheckedSync, type SyncCheckpoint } from '@/android/shared/sync/syncContext';
import { notesRepository } from '@/android/shared/data';
import { fetchFolders } from '@/android/shared/data/remote/notesApi';
import { FOLDERS_CURSOR_KEY } from '@/android/shared/sync/pullCursors';

export async function pullFolders(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(FOLDERS_CURSOR_KEY);
  checkpoint();
  const remote = await fetchFolders(since);
  checkpoint();

  let maxUpdatedAt = since ?? '';
  for (const r of remote) {
    notesRepository.applyRemoteFolder(r);
    if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
  }

  if (maxUpdatedAt) notesRepository.setSyncState(FOLDERS_CURSOR_KEY, maxUpdatedAt);
}
