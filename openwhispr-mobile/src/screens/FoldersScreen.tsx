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
import { SectionHeader } from '@/components/notes/SectionHeader';
import { NewFolderSheet } from '@/components/notes/NewFolderSheet';
import { SpacesSection } from '@/components/notes/SpacesSection';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { groupNotesByDate } from '@/lib/groupNotesByDate';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { SyncStatusLabel } from '@/components/notes/SyncStatusLabel';
import { useSyncStore } from '@/sync/useSyncStore';
import { requestSync } from '@/sync/syncEngine';
import { Fab, FAB_BOTTOM_PADDING, type FabAction } from '@/components/ui/Fab';

const FAB_ACTIONS: FabAction[] = [
  { id: 'note', label: 'New Note', icon: 'square.and.pencil', mdIcon: 'SquarePen' },
  { id: 'meeting', label: 'Record meeting', icon: 'mic', mdIcon: 'Mic' },
  { id: 'folder', label: 'New Folder', icon: 'folder.badge.plus', mdIcon: 'FolderPlus' },
];

export default function FoldersScreen() {
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

  const trimmedQuery = searchValue.trim();
  const isSearching = trimmedQuery.length > 0;

  // folderCounts is included so results refresh when notes are added/removed
  // anywhere in the app while a search is open.
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    return notesRepository.searchNotes(trimmedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmedQuery, isSearching, folderCounts]);

  const buckets = useMemo(() => groupNotesByDate(searchResults), [searchResults]);

  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);

  const teamSpaces = useMemo(() => spaces.filter((s) => s.kind === 'team'), [spaces]);

  const syncStatus = useSyncStore((s) => s.status);
  const onRefresh = useCallback(() => {
    requestSync('manual');
  }, []);

  const goToFolder = useCallback(
    (folderId: number) => {
      safeHaptics('selection');
      setActiveFolderId(folderId);
      router.push({ pathname: '/(tabs)/(notes)/notes', params: { folderId: String(folderId) } });
    },
    [setActiveFolderId],
  );

  const goToSpace = useCallback(
    (spaceId: number) => {
      safeHaptics('selection');
      setActiveSpaceId(spaceId);
      router.push({ pathname: '/(tabs)/(notes)/notes', params: { spaceId: String(spaceId) } });
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
    (id: number) => {
      confirmDestructive('Delete Note', 'This note will be deleted permanently.', () => {
        safeHaptics('warning');
        deleteNote(id);
      });
    },
    [deleteNote],
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
    [renameFolder, deleteFolderSafe, folderCounts],
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
        title={isSearching ? 'Search' : 'Folders'}
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
        refreshControl={
          <RefreshControl refreshing={syncStatus === 'running'} onRefresh={onRefresh} />
        }
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
                    {`No results for "${trimmedQuery}"`}
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
                      onDelete={() => handleDeleteNote(note.id)}
                    />
                  ))}
                </GroupedList>
              </View>
            ))
          )
        ) : (
          <>
            <SectionHeader label="Private Space" />
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
        accessibilityLabel="Create"
        actions={FAB_ACTIONS}
        onActionPress={handleFabAction}
      />

      <NewFolderSheet
        visible={newFolderVisible}
        onClose={() => setNewFolderVisible(false)}
        onCreate={handleCreateFolder}
      />
    </View>
  );
}
