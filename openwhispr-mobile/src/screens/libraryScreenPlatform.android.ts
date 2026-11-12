import { useCallback, useMemo, type ReactNode } from 'react';
import { useFocusEffect } from 'expo-router';
import type { TOptions } from 'i18next';
import type { Folder, Note } from '@/data';
import type { FabAction } from '@/components/ui/Fab';
import type { NotesStore } from '@/store/createNotesStore';
import { useNotesStore } from '@/store/useNotesStore';
import { groupNotesByDate, type DateBucket } from '@/lib/groupNotesByDate';

export type LibraryTranslate = (key: string, options?: TOptions) => string;
export interface LibraryPresentation {
  copy: (key: string, fallback: string, options?: TOptions) => string;
  t: LibraryTranslate;
}
export interface FolderRename {
  open: (folder: { id: number; name: string }) => void;
  sheet: ReactNode;
}
export interface LibraryFolderMenu {
  folderId: number;
  folderName: string;
  folderCounts: Record<number, number>;
  canDelete: boolean;
  space: boolean;
  openRename: FolderRename['open'];
  deleteFolderSafe: NotesStore['deleteFolderSafe'];
  t: LibraryTranslate;
}
export interface LibraryScope {
  folderId: number | null;
  spaceId: number | null;
  staleOwner?: boolean;
}
export interface LibraryFocus extends LibraryScope {
  isInitialized: boolean;
  setActiveFolderId: NotesStore['setActiveFolderId'];
  setActiveSpaceId: NotesStore['setActiveSpaceId'];
}
export interface LibraryScreenPlatform {
  usePresentation: () => LibraryPresentation;
  useBuckets: (notes: Note[]) => DateBucket[];
  useRenameFolder: (rename: NotesStore['renameFolder']) => FolderRename;
  renderAccountButton: () => ReactNode;
  withRouteOwner: (params: { folderId?: string; spaceId?: string }) => {
    folderId?: string;
    spaceId?: string;
    dataOwner?: string;
  };
  showFolderMenu: (options: LibraryFolderMenu) => void;
  translateFabActions: (actions: FabAction[], t: LibraryTranslate) => FabAction[];
}
export interface NotesListPlatform extends LibraryScreenPlatform {
  getScope: (
    folderId: number | null,
    spaceId: number | null,
    routeOwner: string | undefined,
    folders: Folder[],
  ) => LibraryScope;
  useSelectionFocus: (options: LibraryFocus) => void;
  supportsVoiceEnrollment: () => boolean;
}

const defaultPresentation: LibraryPresentation = {
  copy: (_key, fallback) => fallback,
  t: (key) => key,
};
export function useDefaultLibraryPresentation() {
  return defaultPresentation;
}
export function useDefaultLibraryBuckets(notes: Note[]) {
  return useMemo(() => groupNotesByDate(notes), [notes]);
}
export function useDefaultLibraryFocus({
  folderId,
  spaceId,
  setActiveFolderId,
  setActiveSpaceId,
}: LibraryFocus) {
  useFocusEffect(
    useCallback(() => {
      // Reassert only a changed scope so a no-op return preserves search.
      const { activeFolderId: storeFolderId, activeSpaceId: storeSpaceId } =
        useNotesStore.getState();
      if (spaceId != null) {
        if (storeSpaceId !== spaceId) setActiveSpaceId(spaceId);
      } else if (storeFolderId !== folderId) {
        setActiveFolderId(folderId);
      }
    }, [folderId, spaceId, setActiveFolderId, setActiveSpaceId]),
  );
}
