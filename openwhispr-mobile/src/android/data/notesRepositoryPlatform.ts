import { and, eq, isNull } from 'drizzle-orm';
import { spaces } from '@/db/schema';
import type { NotesRepository } from '@/data/types';
import { meetingTranscriptionIdKey } from '@/lib/notes/meetingTranscriptionId';

type NotesDb = typeof import('@/db').db;
type FolderRepository = Pick<NotesRepository, 'getFolders' | 'getPrivateFolders'>;

export function prepareNoteLocation(
  database: NotesDb,
  repository: FolderRepository,
  folderId?: number,
  spaceId?: number,
) {
  const targetSpace =
    spaceId == null
      ? null
      : database
          .select()
          .from(spaces)
          .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
          .get();
  const privateFolders = targetSpace ? [] : repository.getPrivateFolders();
  const targetFolder = targetSpace
    ? null
    : (repository.getFolders().find((folder) => folder.id === folderId) ??
      privateFolders.find((folder) => folder.isDefault) ??
      privateFolders[0] ??
      null);
  return {
    folderId: targetFolder?.id ?? null,
    getSpaceId: () => targetFolder?.spaceId ?? targetSpace?.id,
  };
}

export function prepareNoteDeletion(
  repository: Pick<NotesRepository, 'clearSyncState'>,
  noteId: number,
): void {
  repository.clearSyncState(meetingTranscriptionIdKey(noteId));
}
