import { uncheckedSync, type SyncCheckpoint } from './syncContext';
import { notesRepository } from '@/data';
import { fetchNotes } from '@/data/remote/notesApi';
import { NOTES_CURSOR_KEY } from './pullCursors';

// Shared with the team pass (pullNotesTeam.ts) so both crawls page identically.
export const PAGE_SIZE = 200;
export const EPOCH = new Date(0).toISOString();

export async function pullNotes(checkpoint: SyncCheckpoint = uncheckedSync): Promise<void> {
  checkpoint();
  const since = notesRepository.getSyncState(NOTES_CURSOR_KEY);

  const folderMap = new Map<string, number>();
  for (const f of notesRepository.getFolders()) {
    if (f.remoteId) folderMap.set(f.remoteId, f.id);
  }
  const resolveFolder = (serverFolderId: string | null): number | null =>
    serverFolderId ? (folderMap.get(serverFolderId) ?? null) : null;

  // Epoch-based delta crawl: the first sync pages through the whole library
  // in (updated_at, id) order instead of pulling a single snapshot page. The
  // composite cursor resumes exactly, so pages always advance.
  let cursor = since ?? EPOCH;
  let cursorId: string | undefined;
  let maxUpdatedAt = since ?? '';
  while (true) {
    checkpoint();
    const { notes, hasMore } = await fetchNotes({
      since: cursor,
      sinceId: cursorId,
      limit: PAGE_SIZE,
    });
    checkpoint();
    for (const r of notes) {
      notesRepository.applyRemoteNote(r, resolveFolder);
      if (r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at;
    }
    // A short page always means done; hasMore saves one request when the
    // total is an exact multiple of the page size.
    if (notes.length < PAGE_SIZE || hasMore === false) break;
    const last = notes[notes.length - 1];
    cursor = last.updated_at;
    cursorId = last.id;
  }

  if (maxUpdatedAt) notesRepository.setSyncState(NOTES_CURSOR_KEY, maxUpdatedAt);
}
