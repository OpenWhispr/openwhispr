import {
  useDefaultLibraryPresentation,
  useDefaultLibraryBuckets,
  type LibraryScreenPlatform,
} from './libraryScreenPlatform.android';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { View, ScrollView, Alert, ActionSheetIOS, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/Text';

const SCROLL_PADDING = 16;
import { router } from 'expo-router';
import { useNotesStore } from '@/store/useNotesStore';
import { notesRepository } from '@/data';
import { NotesTopBar } from '@/components/notes/NotesTopBar';
import { GroupedList } from '@/components/notes/GroupedList';
import { FolderRow } from '@/components/notes/FolderRow';
import { NoteRow } from '@/components/notes/NoteRow';
import type { RestoreRow } from '@/components/ui/SwipeableCard';
import { SectionHeader } from '@/components/notes/SectionHeader';
import { NewFolderSheet } from '@/components/notes/NewFolderSheet';
import { SpacesSection } from '@/components/notes/SpacesSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { SyncStatusLabel } from '@/components/notes/SyncStatusLabel';
import { useManualSyncRefresh } from '@/hooks/useManualSyncRefresh';
import { Fab, FAB_BOTTOM_PADDING, type FabAction } from '@/components/ui/Fab';

const FAB_ACTIONS: FabAction[] = [
  { id: 'note', label: 'New Note', icon: 'square.and.pencil', mdIcon: 'SquarePen' },
  { id: 'meeting', label: 'Record meeting', icon: 'mic', mdIcon: 'Mic' },
  { id: 'folder', label: 'New Folder', icon: 'folder.badge.plus', mdIcon: 'FolderPlus' },
];

export function createFoldersScreen(platform?: LibraryScreenPlatform) {
  const usePresentation = platform?.usePresentation ?? useDefaultLibraryPresentation;
  const useBuckets = platform?.useBuckets ?? useDefaultLibraryBuckets;
  const useRenameFolder = platform?.useRenameFolder ?? (() => undefined);
  return function FoldersScreen() {
    const { t, copy } = usePresentation();
    const {
      folders,
      folderCounts,
      spaces,
      initialize,
      isInitialized,
      setActiveFolderId,
      setActiveSpaceId,
      setActiveNoteId,
      createNote,
      createFolder,
      renameFolder,
      deleteFolderSafe,
      deleteNote,
    } = useNotesStore();
    const [searchValue, setSearchValue] = useState('');
    const [newFolderVisible, setNewFolderVisible] = useState(false);
    const rename = useRenameFolder(renameFolder);
    const openRename = rename?.open;

    const trimmedQuery = searchValue.trim();
    const isSearching = trimmedQuery.length > 0;

    // folderCounts is included so results refresh when notes are added/removed
    // anywhere in the app while a search is open.
    const searchResults = useMemo(() => {
      if (!isSearching) return [];
      return notesRepository.searchNotes(trimmedQuery);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trimmedQuery, isSearching, folderCounts]);

    const buckets = useBuckets(searchResults);

    useEffect(() => {
      if (!isInitialized) initialize();
    }, [isInitialized, initialize]);

    const teamSpaces = useMemo(() => spaces.filter((s) => s.kind === 'team'), [spaces]);

    const { refreshing, onRefresh } = useManualSyncRefresh();

    const goToFolder = useCallback(
      (folderId: number) => {
        safeHaptics('selection');
        setActiveFolderId(folderId);
        router.push({
          pathname: '/(tabs)/(notes)/notes',
          params: platform
            ? platform.withRouteOwner({ folderId: String(folderId) })
            : { folderId: String(folderId) },
        });
      },
      [setActiveFolderId],
    );

    const goToSpace = useCallback(
      (spaceId: number) => {
        safeHaptics('selection');
        setActiveSpaceId(spaceId);
        router.push({
          pathname: '/(tabs)/(notes)/notes',
          params: platform
            ? platform.withRouteOwner({ spaceId: String(spaceId) })
            : { spaceId: String(spaceId) },
        });
      },
      [setActiveSpaceId],
    );

    const handleCompose = useCallback(() => {
      const defaultFolder = folders.find((f) => f.isDefault) ?? folders[0];
      if (!defaultFolder) return;
      const note = createNote(undefined, undefined, defaultFolder.id);
      router.push(`/(tabs)/(notes)/${note.id}`);
    }, [folders, createNote]);

    const handleNotePress = useCallback(
      (id: number) => {
        safeHaptics('selection');
        setActiveNoteId(id);
        router.push(`/(tabs)/(notes)/${id}`);
      },
      [setActiveNoteId],
    );

    const handleDeleteNote = useCallback(
      (id: number, restoreRow?: RestoreRow) => {
        confirmDestructive(
          copy('library.deleteNote', 'Delete Note'),
          copy('library.deleteNoteBody', 'This note will be deleted permanently.'),
          () => {
            safeHaptics('warning');
            deleteNote(id);
          },
          platform
            ? {
                cancelLabel: copy('cancel', 'Cancel'),
                destructiveLabel: copy('deleteAction', 'Delete'),
                onCancel: restoreRow,
              }
            : { onCancel: restoreRow },
        );
      },
      [deleteNote, copy],
    );

    const handleNewFolder = useCallback(() => {
      safeHaptics('light');
      setNewFolderVisible(true);
    }, []);

    const handleCreateFolder = useCallback(
      (name: string) => {
        createFolder(name);
      },
      [createFolder],
    );

    const handleFolderLongPress = useCallback(
      (folderId: number, folderName: string, isDefault: number | null) => {
        if (isDefault) {
          safeHaptics('light');
          return;
        }
        safeHaptics('medium');
        if (platform && openRename) {
          platform.showFolderMenu({
            folderId: folderId,
            folderName,
            folderCounts,
            canDelete: true,
            space: false,
            openRename,
            deleteFolderSafe,
            t,
          });
          return;
        }
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: ['Rename', 'Delete', 'Cancel'],
            destructiveButtonIndex: 1,
            cancelButtonIndex: 2,
          },
          (index) => {
            if (index === 0) {
              Alert.prompt('Rename Folder', '', (text) => {
                const trimmed = text?.trim();
                if (trimmed) renameFolder(folderId, trimmed);
              });
            } else if (index === 1) {
              const noteCount = folderCounts[folderId] ?? 0;
              confirmDestructive(
                'Delete Folder',
                noteCount > 0
                  ? `"${folderName}" and its ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} will be deleted.`
                  : `"${folderName}" will be deleted.`,
                () => deleteFolderSafe(folderId),
              );
            }
          },
        );
      },
      [renameFolder, deleteFolderSafe, folderCounts, t, openRename],
    );

    const handleFabAction = useCallback(
      (id: string) => {
        if (id === 'note') {
          handleCompose();
        } else if (id === 'meeting') {
          router.push('/(tabs)/(notes)/meeting-record');
        } else if (id === 'folder') {
          handleNewFolder();
        }
      },
      [handleCompose, handleNewFolder],
    );

    return (
      <View className="flex-1 bg-systemBackground">
        <NotesTopBar
          {...(platform ? { rightSlots: platform.renderAccountButton() } : {})}
          title={
            isSearching ? copy('library.search', 'Search') : copy('library.folders', 'Folders')
          }
          searchValue={searchValue}
          onSearchChange={setSearchValue}
        />
        <ScrollView
          contentContainerStyle={{
            padding: SCROLL_PADDING,
            paddingBottom: FAB_BOTTOM_PADDING,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          <SyncStatusLabel />

          {isSearching ? (
            buckets.length === 0 ? (
              <GroupedList>
                <GroupedList.Row contentInsetLeft={16}>
                  <View className="items-center gap-2 py-8">
                    <SystemIcon
                      name="magnifyingglass"
                      mdName="Search"
                      size={32}
                      color="quaternaryLabel"
                    />
                    <Text className="text-[15px] text-tertiaryLabel">
                      {copy('library.noResults', `No results for "${trimmedQuery}"`, {
                        query: trimmedQuery,
                      })}
                    </Text>
                  </View>
                </GroupedList.Row>
              </GroupedList>
            ) : (
              buckets.map((bucket) => (
                <View key={bucket.key}>
                  <SectionHeader label={bucket.label} />
                  <GroupedList dividerInset={16} tinted>
                    {bucket.notes.map((note) => (
                      <NoteRow
                        key={note.id}
                        note={note}
                        bucket={bucket.key}
                        tinted
                        onPress={() => handleNotePress(note.id)}
                        onDelete={(restoreRow) => handleDeleteNote(note.id, restoreRow)}
                      />
                    ))}
                  </GroupedList>
                </View>
              ))
            )
          ) : (
            <>
              <SectionHeader label={copy('library.privateSpace', 'Private Space')} />
              <GroupedList>
                {folders.map((folder) => (
                  <FolderRow
                    key={folder.id}
                    sfName="folder"
                    mdName="Folder"
                    label={folder.name}
                    count={folderCounts[folder.id] ?? 0}
                    onPress={() => goToFolder(folder.id)}
                    onLongPress={() =>
                      handleFolderLongPress(folder.id, folder.name, folder.isDefault)
                    }
                  />
                ))}
              </GroupedList>

              <SpacesSection spaces={teamSpaces} onSelect={goToSpace} />
            </>
          )}
        </ScrollView>

        <Fab
          icon="plus"
          mdIcon="Plus"
          accessibilityLabel={copy('library.create', 'Create')}
          actions={platform ? platform.translateFabActions(FAB_ACTIONS, t) : FAB_ACTIONS}
          onActionPress={handleFabAction}
        />

        {rename?.sheet}
        <NewFolderSheet
          visible={newFolderVisible}
          onClose={() => setNewFolderVisible(false)}
          onCreate={handleCreateFolder}
        />
      </View>
    );
  };
}
