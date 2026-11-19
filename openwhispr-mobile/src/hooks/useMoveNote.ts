import { useCallback, useMemo, useState } from 'react';
import type { MoveToFolderSheetProps } from '@/components/notes/MoveToFolderSheet';
import type { Folder, Note, Space } from '@/data';
import {
  foldersInPrivateWorkspace,
  groupPrivateFoldersByWorkspace,
  privateWorkspaceOf,
  type PrivateFolderGroup,
} from '@/lib/privateWorkspaces';
import { canMoveBetweenSpaces } from '@/lib/spacePermissions';
import { safeHaptics } from '@/lib/utils';
import { useNotesStore } from '@/store/useNotesStore';

export interface UseMoveNoteOptions {
  /** The team space the content belongs to, or null for personal content. */
  scopeSpaceId: number | null;
  /** Folders offered as targets, always from the same space (or Private) as the note. */
  targetFolders: Folder[];
  excludeFolderId: number | null;
  /** Initial Private context, until opening a note resolves its own workspace. */
  privateWorkspaceId?: string | null;
}

export interface UseMoveNoteResult {
  open: (noteId: number) => void;
  close: () => void;
  sheetProps: MoveToFolderSheetProps;
}

export function useMoveNote({
  scopeSpaceId: browsingSpaceId,
  targetFolders,
  excludeFolderId,
  privateWorkspaceId,
}: UseMoveNoteOptions): UseMoveNoteResult {
  const spaces = useNotesStore((s) => s.spaces);
  const notes = useNotesStore((s): Note[] => s.notes);
  const getNoteById = useNotesStore((s): typeof s.getNoteById => s.getNoteById);
  const getSpaceFolders = useNotesStore((s): typeof s.getSpaceFolders => s.getSpaceFolders);
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

  const note = useMemo(
    (): Note | null =>
      movingNoteId == null
        ? null
        : (notes.find((candidate): boolean => candidate.id === movingNoteId) ??
          getNoteById(movingNoteId)),
    [getNoteById, movingNoteId, notes],
  );
  const noteSpace = spaces.find((space): boolean => space.id === note?.spaceId);
  const isSpaceUnknown = note?.spaceId != null && !noteSpace;
  const scopeSpaceId = note ? (noteSpace?.kind === 'team' ? noteSpace.id : null) : browsingSpaceId;
  const isPersonal = !isSpaceUnknown && scopeSpaceId == null;
  const allPrivateFolders = useMemo(
    (): Folder[] => getAllPrivateFolders(),
    // The active folder list is replaced whenever the repository's folders change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getAllPrivateFolders, activePrivateFolders],
  );
  // Sync can change the active workspace while a list still displays the original folder.
  // Resolve the selected note, so its own folders never become implicit cross-workspace moves.
  const sourceFolder = allPrivateFolders.find((folder): boolean => folder.id === note?.folderId);
  const placedWorkspaceId = sourceFolder
    ? privateWorkspaceOf(sourceFolder, defaultPrivateWorkspaceId)
    : (note?.privateWorkspaceId ?? defaultPrivateWorkspaceId);
  const noteWorkspaceId = note
    ? placedWorkspaceId &&
      !privateWorkspaces.some((workspace): boolean => workspace.id === placedWorkspaceId)
      ? defaultPrivateWorkspaceId
      : placedWorkspaceId
    : privateWorkspaceId === undefined
      ? activePrivateWorkspaceId
      : privateWorkspaceId;
  // Empty until the API keeps a Private per workspace: then every note is the default's.
  const perWorkspacePrivate = privateWorkspaces.length > 0;

  const moveTargetFolders = useMemo((): Folder[] => {
    if (isSpaceUnknown) return [];
    if (note && scopeSpaceId != null) return getSpaceFolders(scopeSpaceId);
    return isPersonal
      ? foldersInPrivateWorkspace(
          note ? allPrivateFolders : targetFolders,
          noteWorkspaceId,
          defaultPrivateWorkspaceId,
        )
      : targetFolders;
  }, [
    isSpaceUnknown,
    note,
    scopeSpaceId,
    getSpaceFolders,
    isPersonal,
    allPrivateFolders,
    targetFolders,
    noteWorkspaceId,
    defaultPrivateWorkspaceId,
  ]);

  // Where this note is allowed to go, by desktop's rule: team content stays inside its own
  // workspace and never returns to Private. Personal content moves to its own workspace's team
  // spaces (any, while only the default's Private exists).
  const targetSpaces = useMemo((): Space[] => {
    if (isSpaceUnknown) return [];
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
  }, [isSpaceUnknown, spaces, scopeSpaceId, isPersonal, perWorkspacePrivate, noteWorkspaceId]);

  // The account's other Privates, each under its workspace's name, so filing a note in another
  // workspace is always an explicit pick.
  const privateGroups = useMemo((): PrivateFolderGroup<Folder>[] => {
    if (!isPersonal || !perWorkspacePrivate) return [];
    return groupPrivateFoldersByWorkspace(allPrivateFolders, {
      workspaces: privateWorkspaces,
      defaultId: defaultPrivateWorkspaceId,
    }).filter((group) => group.workspaceId !== noteWorkspaceId && group.folders.length > 0);
  }, [
    isPersonal,
    perWorkspacePrivate,
    allPrivateFolders,
    privateWorkspaces,
    noteWorkspaceId,
    defaultPrivateWorkspaceId,
  ]);

  const open = useCallback((noteId: number) => {
    safeHaptics('medium');
    setMovingNoteId(noteId);
  }, []);

  const close = useCallback(() => setMovingNoteId(null), []);

  const pickFolder = useCallback(
    (folderId: number): void => {
      if (isSpaceUnknown) return;
      if (movingNoteId != null) {
        moveNoteToFolder(movingNoteId, folderId);
        safeHaptics('success');
      }
      setMovingNoteId(null);
    },
    [isSpaceUnknown, movingNoteId, moveNoteToFolder],
  );

  const createAndPick = useCallback(
    (name: string): void => {
      if (isSpaceUnknown) return;
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
    [isSpaceUnknown, movingNoteId, createFolder, moveNoteToFolder, scopeSpaceId, noteWorkspaceId],
  );

  const pickSpace = useCallback(
    (spaceId: number): void => {
      if (isSpaceUnknown) return;
      if (movingNoteId != null) {
        moveNoteToSpace(movingNoteId, spaceId);
        safeHaptics('success');
      }
      setMovingNoteId(null);
    },
    [isSpaceUnknown, movingNoteId, moveNoteToSpace],
  );

  return {
    open,
    close,
    sheetProps: {
      visible: movingNoteId != null && !isSpaceUnknown,
      folders: moveTargetFolders,
      folderCounts,
      excludeFolderId: note ? note.folderId : excludeFolderId,
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
