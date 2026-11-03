import { notesRepository, spacesRepository } from '@/data';
import { useAuthStore } from '@/store/useAuthStore';

export class ImportDestinationError extends Error {
  constructor(
    readonly translationKey: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImportDestinationError';
  }
}

export interface ImportDestination {
  ownerId: string | null;
  folderId?: number;
  spaceId: number;
  isPrivate: boolean;
  label: string;
}

/** Resolve once before the picker; never consult the active Notes folder on completion. */
export function resolveImportDestination(input: {
  folderId?: number;
  spaceId?: number;
  isPrivate: boolean;
}): ImportDestination {
  const personal = spacesRepository.getPrivateSpace();
  const spaces = spacesRepository.listSpaces();
  const folder =
    input.folderId == null
      ? undefined
      : notesRepository.getFolders().find((item) => item.id === input.folderId);
  if (input.folderId != null && !folder)
    throw new ImportDestinationError(
      'importFolderUnavailable',
      'This folder is no longer available. Return to Notes and choose a destination.',
    );
  const spaceId = folder?.spaceId ?? input.spaceId ?? personal.id;
  const space = spaces.find((item) => item.id === spaceId);
  if (!space || space.deletedAt)
    throw new ImportDestinationError(
      'importSpaceUnavailable',
      'This space is no longer available. Return to Notes and choose a destination.',
    );
  // Private imports cannot enter a shared space, even when started there.
  const usePersonal = input.isPrivate && space.kind !== 'private';
  return {
    ownerId: useAuthStore.getState().user?.id ?? null,
    folderId: usePersonal ? undefined : folder?.id,
    spaceId: usePersonal ? personal.id : space.id,
    isPrivate: input.isPrivate,
    label: usePersonal ? personal.name : (folder?.name ?? space.name),
  };
}

export function saveImportedNote(
  destination: ImportDestination,
  text: string,
  fileName: string,
  fallbackTitle = 'Imported audio',
) {
  if ((useAuthStore.getState().user?.id ?? null) !== destination.ownerId) {
    throw new ImportDestinationError(
      'importAccountChanged',
      'Your account changed. Start the import again from Notes.',
    );
  }
  const current = resolveImportDestination(destination);
  if (current.spaceId !== destination.spaceId || current.folderId !== destination.folderId) {
    throw new ImportDestinationError(
      'importDestinationChanged',
      'The destination changed. Return to Notes and choose a destination.',
    );
  }
  const title = fileName.replace(/\.[^.]+$/, '').trim() || fallbackTitle;
  // Create an empty row, set privacy, then add the transcript. A privacy-write
  // failure cannot leave the imported text in a syncable row.
  const note = notesRepository.createNote(
    title,
    '',
    destination.folderId,
    destination.folderId == null ? destination.spaceId : undefined,
  );
  try {
    if (destination.isPrivate) notesRepository.setNotePrivacy(note.id, true);
    notesRepository.updateNote(note.id, { content: text });
  } catch (error) {
    notesRepository.deleteNote(note.id);
    throw error;
  }
  return note;
}
