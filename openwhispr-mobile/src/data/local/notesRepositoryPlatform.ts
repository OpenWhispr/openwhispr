import { eq } from 'drizzle-orm';
import { folders } from '@/db/schema';
import type { NotesRepository } from '@/data/types';

type NotesDb = typeof import('@/db').db;
type FolderRepository = Pick<NotesRepository, 'getFolders' | 'getPrivateFolders'>;

export function prepareNoteLocation(
  database: NotesDb,
  _repository: FolderRepository,
  folderId?: number,
  spaceId?: number,
) {
  const targetFolderId = spaceId != null ? null : (folderId ?? 1);
  return {
    folderId: targetFolderId,
    // Read at the original values() position, after the insert builder is created.
    getSpaceId: () =>
      targetFolderId != null
        ? (database
            .select({ spaceId: folders.spaceId })
            .from(folders)
            .where(eq(folders.id, targetFolderId))
            .get()?.spaceId ?? null)
        : spaceId,
  };
}

export function prepareNoteDeletion(
  _repository: Pick<NotesRepository, 'clearSyncState'>,
  _noteId: number,
): void {}
