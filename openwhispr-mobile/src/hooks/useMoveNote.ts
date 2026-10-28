import { useCallback, useMemo, useState } from 'react';
import type { MoveToFolderSheetProps } from '@/components/notes/MoveToFolderSheet';
import type { Folder } from '@/data';
import { canMoveBetweenSpaces } from '@/lib/spacePermissions';
import { safeHaptics } from '@/lib/utils';
import { useNotesStore } from '@/store/useNotesStore';

export interface UseMoveNoteOptions {
  /** The team space the content belongs to, or null for personal content. */
  scopeSpaceId: number | null;
  /** Folders offered as targets, always from the same space as the note. */
  targetFolders: Folder[];
  excludeFolderId: number | null;
}

export interface UseMoveNoteResult {
  open: (noteId: number) => void;
  close: () => void;
  sheetProps: MoveToFolderSheetProps;
}

export function useMoveNote({
  scopeSpaceId,
  targetFolders,
  excludeFolderId,
}: UseMoveNoteOptions): UseMoveNoteResult {
  const spaces = useNotesStore((s) => s.spaces);
  const folderCounts = useNotesStore((s) => s.folderCounts);
  const moveNoteToFolder = useNotesStore((s) => s.moveNoteToFolder);
  const moveNoteToSpace = useNotesStore((s) => s.moveNoteToSpace);
  const createFolder = useNotesStore((s) => s.createFolder);
  const [movingNoteId, setMovingNoteId] = useState<number | null>(null);

  // Where this note is allowed to go, by desktop's rule: personal content may
  // move to any team space, while team content stays inside its own workspace —
  // never back to the private space, and never across workspaces.
  const targetSpaces = useMemo(() => {
    const from =
      scopeSpaceId != null
        ? spaces.find((s) => s.id === scopeSpaceId)
        : spaces.find((s) => s.kind === 'private');
    if (!from) return [];
    return spaces.filter(
      (space) => space.kind === 'team' && space.id !== from.id && canMoveBetweenSpaces(from, space),
    );
  }, [spaces, scopeSpaceId]);

  const open = useCallback((noteId: number) => {
    safeHaptics('medium');
    setMovingNoteId(noteId);
  }, []);

  const close = useCallback(() => setMovingNoteId(null), []);

  const pickFolder = useCallback(
    (folderId: number) => {
      if (movingNoteId != null) {
        moveNoteToFolder(movingNoteId, folderId);
        safeHaptics('success');
      }
      setMovingNoteId(null);
    },
    [movingNoteId, moveNoteToFolder],
  );

  const createAndPick = useCallback(
    (name: string) => {
      const folder = createFolder(name, scopeSpaceId ?? undefined);
      if (movingNoteId != null) {
        moveNoteToFolder(movingNoteId, folder.id);
      }
      setMovingNoteId(null);
    },
    [movingNoteId, createFolder, moveNoteToFolder, scopeSpaceId],
  );

  const pickSpace = useCallback(
    (spaceId: number) => {
      if (movingNoteId != null) {
        moveNoteToSpace(movingNoteId, spaceId);
        safeHaptics('success');
      }
      setMovingNoteId(null);
    },
    [movingNoteId, moveNoteToSpace],
  );

  return {
    open,
    close,
    sheetProps: {
      visible: movingNoteId != null,
      folders: targetFolders,
      folderCounts,
      excludeFolderId,
      onClose: close,
      onPickFolder: pickFolder,
      onCreateAndPick: createAndPick,
      spaces: targetSpaces,
      activeSpaceId: scopeSpaceId,
      onPickSpace: pickSpace,
    },
  };
}
