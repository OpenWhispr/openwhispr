import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AccountButton } from './ui';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useNoteBuckets } from '@/hooks/useNoteBuckets';
import { NewFolderSheet } from '@/components/notes/NewFolderSheet.android';
import { getNotesRouteOwner, withNotesRouteOwner } from '@/lib/notes/noteRouteOwner';
import { supportsVoiceEnrollment } from '@/lib/voiceEnrollmentCapability';
import { confirmDestructive } from '@/lib/alerts';
import { useNotesStore } from '@/store/useNotesStore';
import type { NotesStore } from '@/store/createNotesStore';
import type {
  LibraryFocus,
  LibraryFolderMenu,
  NotesListPlatform,
} from '@/screens/libraryScreenPlatform.android';

function useLibraryPresentation() {
  const { t } = useTranslation('android');
  const { copy } = useAndroidCopy();
  return { t, copy };
}
function useFolderRename(renameFolder: NotesStore['renameFolder']) {
  const [renamingFolder, setRenamingFolder] = useState<{ id: number; name: string } | null>(null);
  return {
    open: setRenamingFolder,
    sheet: (
      <NewFolderSheet
        visible={renamingFolder != null}
        initialName={renamingFolder?.name}
        onClose={() => setRenamingFolder(null)}
        onCreate={(name) => {
          if (renamingFolder) renameFolder(renamingFolder.id, name);
        }}
      />
    ),
  };
}
function showFolderMenu({
  folderId,
  folderName,
  folderCounts,
  canDelete,
  space,
  openRename,
  deleteFolderSafe,
  t,
}: LibraryFolderMenu) {
  Alert.alert(folderName, undefined, [
    { text: t('renameFolder'), onPress: () => openRename({ id: folderId, name: folderName }) },
    ...(canDelete
      ? [
          {
            text: t('deleteFolder'),
            style: 'destructive' as const,
            onPress: () =>
              confirmDestructive(
                t('deleteFolder'),
                t(space ? 'deleteSpaceFolderBody' : 'deleteFolderBody', {
                  name: folderName,
                  count: folderCounts[folderId] ?? 0,
                }),
                () => deleteFolderSafe(folderId),
                { cancelLabel: t('cancel'), destructiveLabel: t('deleteAction') },
              ),
          },
        ]
      : []),
    { text: t('cancel'), style: 'cancel' },
  ]);
}
function useSelectionFocus({
  folderId,
  spaceId,
  staleOwner,
  isInitialized,
  setActiveFolderId,
  setActiveSpaceId,
}: LibraryFocus) {
  useFocusEffect(
    useCallback(() => {
      if (!isInitialized) return;
      if (spaceId != null) setActiveSpaceId(spaceId);
      else setActiveFolderId(folderId);
      const selected = useNotesStore.getState();
      if (
        staleOwner ||
        (spaceId != null
          ? selected.activeSpaceId !== spaceId
          : selected.activeFolderId !== folderId)
      ) {
        router.setParams(
          withNotesRouteOwner({
            folderId: selected.activeFolderId == null ? undefined : String(selected.activeFolderId),
            spaceId: selected.activeSpaceId == null ? undefined : String(selected.activeSpaceId),
          }),
        );
      }
    }, [folderId, spaceId, staleOwner, isInitialized, setActiveFolderId, setActiveSpaceId]),
  );
}
export const androidLibraryScreens: NotesListPlatform = {
  usePresentation: useLibraryPresentation,
  useBuckets: useNoteBuckets,
  useRenameFolder: useFolderRename,
  renderAccountButton: () => <AccountButton />,
  withRouteOwner: withNotesRouteOwner,
  showFolderMenu,
  translateFabActions: (actions, t) =>
    actions.map((action) => ({
      ...action,
      label: t(
        action.id === 'import'
          ? 'importAudio'
          : action.id === 'note'
            ? 'newNote'
            : action.id === 'meeting'
              ? 'meetingSetupTitle'
              : 'newFolder',
      ),
    })),
  getScope: (requestedFolderId, requestedSpaceId, routeOwner, folders) => {
    const dataOwner = getNotesRouteOwner();
    const staleOwner =
      (requestedFolderId != null || requestedSpaceId != null) &&
      (dataOwner === undefined || routeOwner !== dataOwner);
    return {
      folderId: staleOwner
        ? ((folders.find((folder) => folder.isDefault) ?? folders[0])?.id ?? null)
        : requestedFolderId,
      spaceId: staleOwner ? null : requestedSpaceId,
      staleOwner,
    };
  },
  useSelectionFocus,
  supportsVoiceEnrollment,
};
