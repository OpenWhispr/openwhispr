import { useCallback, useMemo, useState } from 'react';
import type { MoveToFolderSheetProps } from '@/components/notes/MoveToFolderSheet';
import type { Folder } from '@/data';
import { groupPrivateFoldersByWorkspace } from '@/lib/privateWorkspaces';
import { canMoveBetweenSpaces } from '@/lib/spacePermissions';
import { safeHaptics } from '@/lib/utils';
import { useNotesStore } from '@/store/useNotesStore';

export interface UseMoveNoteOptions {
  /** The team space the content belongs to, or null for personal content. */
  scopeSpaceId: number | null;
  /** Folders offered as targets, always from the same space (or Private) as the note. */
  targetFolders: Folder[];
  excludeFolderId: number | null;
  /** The workspace whose Private personal content sits in; the active one when omitted. */
  privateWorkspaceId?: string | null;
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
  privateWorkspaceId,
}: UseMoveNoteOptions): UseMoveNoteResult {
  const spaces = useNotesStore((s) => s.spaces);
  const folderCounts = useNotesStore((s) => s.folderCounts);
  const privateWorkspaces = useNotesStore((s) => s.privateWorkspaces);
  const activePrivateWorkspaceId = useNotesStore((s) => s.activePrivateWorkspaceId);
  const defaultPrivateWorkspaceId = useNotesStore((s) => s.defaultPrivateWorkspaceId);
  // Every folder reload (create, rename, move, sync) replaces this list, so it stands in as the
  // signal to re-read the other Privates' folders.
  const activePrivateFolders = useNotesStore((s) => s.folders);
  const getAllPrivateFolders = useNotesStore((s) => s.getAllPrivateFolders);
  const moveNoteToFolder = useNotesStore((s) => s.moveNoteToFolder);
  const moveNoteToSpace = useNotesStore((s) => s.moveNoteToSpace);
  const createFolder = useNotesStore((s) => s.createFolder);
  const [movingNoteId, setMovingNoteId] = useState<number | null>(null);

  const isPersonal = scopeSpaceId == null;
  const noteWorkspaceId =
    privateWorkspaceId === undefined ? activePrivateWorkspaceId : privateWorkspaceId;
  // Empty until the API keeps a Private per workspace: then every note is the default's.
  const perWorkspacePrivate = privateWorkspaces.length > 0;

  // Where this note is allowed to go, by desktop's rule: team content stays inside its own
  // workspace and never returns to Private. Personal content moves to its own workspace's team
  // spaces (any, while only the default's Private exists).
  const targetSpaces = useMemo(() => {
    const from =
      scopeSpaceId != null
        ? spaces.find((s) => s.id === scopeSpaceId)
        : spaces.find((s) => s.kind === 'private');
    if (!from) return [];
    return spaces.filter(
      (space) =>
        space.kind === 'team' &&
        space.id !== from.id &&
        canMoveBetweenSpaces(from, space) &&
        (!isPersonal || !perWorkspacePrivate || space.workspaceId === noteWorkspaceId),
    );
  }, [spaces, scopeSpaceId, isPersonal, perWorkspacePrivate, noteWorkspaceId]);

  // The account's other Privates, each under its workspace's name, so filing a note in another
  // workspace is always an explicit pick.
  const privateGroups = useMemo(() => {
    if (!isPersonal || !perWorkspacePrivate) return [];
    return groupPrivateFoldersByWorkspace(getAllPrivateFolders(), {
      workspaces: privateWorkspaces,
      firstId: noteWorkspaceId,
      defaultId: defaultPrivateWorkspaceId,
    }).filter((group) => group.workspaceId !== noteWorkspaceId && group.folders.length > 0);
    // activePrivateFolders is the refresh signal described above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isPersonal,
    perWorkspacePrivate,
    getAllPrivateFolders,
    privateWorkspaces,
    noteWorkspaceId,
    defaultPrivateWorkspaceId,
    activePrivateFolders,
  ]);

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
      // A new personal folder goes in the note's own Private, which may not be the active one.
      const folder =
        scopeSpaceId != null
          ? createFolder(name, scopeSpaceId)
          : createFolder(name, undefined, { privateWorkspaceId: noteWorkspaceId });
      if (movingNoteId != null) {
        moveNoteToFolder(movingNoteId, folder.id);
      }
      setMovingNoteId(null);
    },
    [movingNoteId, createFolder, moveNoteToFolder, scopeSpaceId, noteWorkspaceId],
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
      privateGroups,
      spaces: targetSpaces,
      activeSpaceId: scopeSpaceId,
      onPickSpace: pickSpace,
    },
  };
}
