import {
  useDefaultLibraryPresentation,
  useDefaultLibraryBuckets,
  useDefaultLibraryFocus,
  type NotesListPlatform,
} from './libraryScreenPlatform';
import { useEffect, useCallback, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, RefreshControl, Alert, ActionSheetIOS } from 'react-native';
import { Text } from '@/components/ui/Text';

const SCROLL_PADDING = 16;
import { router, useLocalSearchParams } from 'expo-router';
import { useNotesStore } from '@/store/useNotesStore';
import { NotesTopBar } from '@/components/notes/NotesTopBar';
import { GroupedList } from '@/components/notes/GroupedList';
import { FolderRow } from '@/components/notes/FolderRow';
import { NoteRow } from '@/components/notes/NoteRow';
import type { RestoreRow } from '@/components/ui/SwipeableCard';
import { SectionHeader } from '@/components/notes/SectionHeader';
import { MoveToFolderSheet } from '@/components/notes/MoveToFolderSheet';
import { NewFolderSheet } from '@/components/notes/NewFolderSheet';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Fab, FAB_BOTTOM_PADDING, type FabAction } from '@/components/ui/Fab';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { SyncStatusLabel } from '@/components/notes/SyncStatusLabel';
import { useManualSyncRefresh } from '@/hooks/useManualSyncRefresh';
import { useMoveNote } from '@/hooks/useMoveNote';

export function createNotesListScreen(platform?: NotesListPlatform) {
  const usePresentation = platform?.usePresentation ?? useDefaultLibraryPresentation;
  const useBuckets = platform?.useBuckets ?? useDefaultLibraryBuckets;
  const useRenameFolder = platform?.useRenameFolder ?? (() => undefined);
  const useSelectionFocus = platform?.useSelectionFocus ?? useDefaultLibraryFocus;
  return function NotesListScreen() {
    const { t, copy } = usePresentation();
    const params = useLocalSearchParams<{
      folderId?: string;
      spaceId?: string;
      dataOwner?: string;
    }>();
    const requestedFolderId = params.folderId ? Number(params.folderId) : null;
    const requestedSpaceId = params.spaceId ? Number(params.spaceId) : null;

    const {
      folders,
      spaceFolders,
      folderCounts,
      notes,
      spaces,
      activeFolderId,
      isInitialized,
      initialize,
      setActiveFolderId,
      setActiveSpaceId,
      setActiveNoteId,
      setSearchQuery,
      searchQuery,
      createNote,
      deleteNote,
      createFolder,
      renameFolder,
      deleteFolderSafe,
      voiceProfiles,
      loadVoiceProfiles,
    } = useNotesStore();

    const { folderId, spaceId, staleOwner } = platform
      ? platform.getScope(requestedFolderId, requestedSpaceId, params.dataOwner, folders)
      : { folderId: requestedFolderId, spaceId: requestedSpaceId, staleOwner: undefined };

    const [newFolderVisible, setNewFolderVisible] = useState(false);
    const rename = useRenameFolder(renameFolder);
    const openRename = rename?.open;

    useEffect(() => {
      if (!isInitialized) initialize();
    }, [isInitialized, initialize]);

    useEffect(() => {
      loadVoiceProfiles();
    }, [loadVoiceProfiles]);

    useSelectionFocus({
      folderId,
      spaceId,
      staleOwner,
      isInitialized,
      setActiveFolderId,
      setActiveSpaceId,
    });

    const activeFolder =
      folderId != null
        ? (folders.find((f) => f.id === folderId) ?? spaceFolders.find((f) => f.id === folderId))
        : null;
    const activeSpace = spaceId != null ? spaces.find((s) => s.id === spaceId) : null;
    const screenTitle = activeSpace?.name ?? activeFolder?.name ?? copy('notes', 'Notes');

    // The space this screen's content belongs to — set both when browsing a space
    // and when browsing one of its folders, so move targets never cross scopes.
    const contentSpaceId = useMemo(
      () => spaceId ?? spaceFolders.find((f) => f.id === folderId)?.spaceId ?? null,
      [spaceId, folderId, spaceFolders],
    );
    const moveTargetFolders = contentSpaceId != null ? spaceFolders : folders;
    const move = useMoveNote({
      scopeSpaceId: contentSpaceId,
      targetFolders: moveTargetFolders,
      excludeFolderId: activeFolderId,
    });

    const buckets = useBuckets(notes);
    const totalCount = useMemo(() => {
      if (spaceId == null) return notes.length;
      return (
        notes.length + spaceFolders.reduce((sum, folder) => sum + (folderCounts[folder.id] ?? 0), 0)
      );
    }, [spaceId, notes.length, spaceFolders, folderCounts]);

    // Folders replace the empty state while browsing a space, but a search must
    // still be able to report "no results".
    const showSpaceFolders = spaceId != null && spaceFolders.length > 0 && !searchQuery;

    const { refreshing, onRefresh } = useManualSyncRefresh();

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

    const handleCompose = useCallback(() => {
      const note = createNote();
      router.push(`/(tabs)/(notes)/${note.id}`);
    }, [createNote]);

    const goToFolder = useCallback((targetFolderId: number) => {
      safeHaptics('selection');
      router.push({
        pathname: '/(tabs)/(notes)/notes',
        params: platform
          ? platform.withRouteOwner({ folderId: String(targetFolderId) })
          : { folderId: String(targetFolderId) },
      });
    }, []);

    const handleCreateFolderInSpace = useCallback(
      (name: string) => {
        if (spaceId == null) return;
        createFolder(name, spaceId);
      },
      [spaceId, createFolder],
    );

    // Folders are only creatable from a space screen; the personal list has its
    // own New Folder action over on FoldersScreen.
    const fabActions = useMemo<FabAction[]>(() => {
      const actions: FabAction[] = [
        { id: 'note', label: 'New note', icon: 'square.and.pencil', mdIcon: 'SquarePen' },
        { id: 'meeting', label: 'Record meeting', icon: 'mic', mdIcon: 'Mic' },
      ];
      if (platform)
        actions.push({
          id: 'import',
          label: t('importAudio'),
          icon: 'square.and.arrow.down',
          mdIcon: 'FileAudio',
        });
      if (spaceId != null) {
        actions.push({
          id: 'folder',
          label: 'New Folder',
          icon: 'folder.badge.plus',
          mdIcon: 'FolderPlus',
        });
      }
      return actions;
    }, [spaceId, t]);

    // Deleting a space folder tombstones its notes for everyone in the space, so
    // the server allows it to admins only (requireSpaceFolderAdmin). Renaming has
    // no such restriction — any member with write access may.
    const canDeleteSpaceFolders = activeSpace?.myRole === 'admin';

    const handleSpaceFolderLongPress = useCallback(
      (targetFolderId: number, folderName: string, isDefault: number | null) => {
        safeHaptics('medium');
        // The server refuses to delete a default folder outright, so never offer it.
        const canDelete = canDeleteSpaceFolders && !isDefault;
        if (platform && openRename) {
          platform.showFolderMenu({
            folderId: targetFolderId,
            folderName,
            folderCounts,
            canDelete: canDelete,
            space: true,
            openRename,
            deleteFolderSafe,
            t,
          });
          return;
        }
        const options = canDelete ? ['Rename', 'Delete', 'Cancel'] : ['Rename', 'Cancel'];
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options,
            destructiveButtonIndex: canDelete ? 1 : undefined,
            cancelButtonIndex: options.length - 1,
          },
          (index) => {
            if (index === 0) {
              Alert.prompt('Rename Folder', '', (text) => {
                const trimmed = text?.trim();
                if (trimmed) renameFolder(targetFolderId, trimmed);
              });
            } else if (canDelete && index === 1) {
              const noteCount = folderCounts[targetFolderId] ?? 0;
              confirmDestructive(
                'Delete Folder',
                noteCount > 0
                  ? `"${folderName}" and its ${noteCount} ${noteCount === 1 ? 'note' : 'notes'} will be deleted for everyone in this space.`
                  : `"${folderName}" will be deleted for everyone in this space.`,
                () => deleteFolderSafe(targetFolderId),
              );
            }
          },
        );
      },
      [canDeleteSpaceFolders, renameFolder, deleteFolderSafe, folderCounts, t, openRename],
    );

    const handleFabAction = useCallback(
      (id: string) => {
        if (id === 'note') {
          handleCompose();
        } else if (id === 'meeting' || (platform && id === 'import')) {
          // The meeting is filed where it was started: this folder, or this space.
          const startedIn: { folderId?: string; spaceId?: string } = {};
          if (params.folderId) startedIn.folderId = params.folderId;
          else if (params.spaceId) startedIn.spaceId = params.spaceId;
          router.push({
            pathname:
              id === 'import' ? '/(tabs)/(notes)/import-audio' : '/(tabs)/(notes)/meeting-record',
            params: startedIn,
          });
        } else if (id === 'folder') {
          safeHaptics('light');
          setNewFolderVisible(true);
        }
      },
      [handleCompose, params.folderId, params.spaceId],
    );

    const openVoiceProfiles = useCallback(() => {
      safeHaptics('selection');
      router.push('/(tabs)/(notes)/voice-profiles');
    }, []);

    return (
      <View className="flex-1 bg-systemBackground">
        <NotesTopBar
          {...(platform ? { rightSlots: platform.renderAccountButton() } : {})}
          showBack
          title={screenTitle}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
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
          <Text className="mb-2 text-[15px] text-tertiaryLabel">
            {copy('library.noteCount', `${totalCount} ${totalCount === 1 ? 'Note' : 'Notes'}`, {
              count: totalCount,
            })}
          </Text>
          <SyncStatusLabel />

          {!platform || platform.supportsVoiceEnrollment() || voiceProfiles.length > 0 ? (
            <View className="mb-2">
              <GroupedList>
                <GroupedList.Row
                  leadingIconSlot={
                    <SystemIcon name="waveform" mdName="AudioLines" size={22} color="brand" />
                  }
                  onPress={openVoiceProfiles}
                  accessibilityRole="button"
                  accessibilityLabel={copy('library.voiceProfiles', 'Voice Profiles')}
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="min-w-0 flex-1">
                      <Text className="text-[16px] font-medium text-label">
                        {copy('library.voiceProfiles', 'Voice Profiles')}
                      </Text>
                      <Text className="mt-0.5 text-[13px] text-secondaryLabel">
                        {voiceProfiles.length === 0
                          ? copy('library.teachVoice', 'Teach OpenWhispr your voice')
                          : copy(
                              'library.voiceCount',
                              `${voiceProfiles.length} ${voiceProfiles.length === 1 ? 'voice' : 'voices'}`,
                              { count: voiceProfiles.length },
                            )}
                      </Text>
                    </View>
                    <SystemIcon
                      name="chevron.right"
                      mdName="ChevronRight"
                      size={13}
                      color="tertiaryLabel"
                    />
                  </View>
                </GroupedList.Row>
              </GroupedList>
            </View>
          ) : null}

          {showSpaceFolders && (
            <View className="mb-2">
              <SectionHeader label={copy('library.folders', 'Folders')} />
              <GroupedList>
                {spaceFolders.map((folder) => (
                  <FolderRow
                    key={folder.id}
                    sfName="folder"
                    mdName="Folder"
                    label={folder.name}
                    count={folderCounts[folder.id] ?? 0}
                    onPress={() => goToFolder(folder.id)}
                    onLongPress={() =>
                      handleSpaceFolderLongPress(folder.id, folder.name, folder.isDefault)
                    }
                  />
                ))}
              </GroupedList>
            </View>
          )}

          {buckets.length === 0 && !showSpaceFolders ? (
            <View className="mt-6">
              <GroupedList>
                <GroupedList.Row contentInsetLeft={16}>
                  {searchQuery ? (
                    <View className="items-center gap-2 py-8">
                      <SystemIcon
                        name="magnifyingglass"
                        mdName="Search"
                        size={32}
                        color="quaternaryLabel"
                      />
                      <Text className="text-[15px] text-tertiaryLabel">
                        {copy('library.noResults', `No results for "${searchQuery}"`, {
                          query: searchQuery,
                        })}
                      </Text>
                    </View>
                  ) : (
                    <View className="items-center gap-3 py-10">
                      <SystemIcon
                        name="note.text"
                        mdName="FileText"
                        size={36}
                        color="quaternaryLabel"
                      />
                      <View className="items-center gap-1">
                        <Text className="text-[17px] font-semibold text-label">
                          {copy('library.noNotes', 'No notes here yet')}
                        </Text>
                        <Text className="text-[15px] text-tertiaryLabel">
                          {copy('library.firstNote', 'Create your first note to start writing')}
                        </Text>
                      </View>
                      <Pressable
                        onPress={handleCompose}
                        accessibilityRole="button"
                        accessibilityLabel={copy('library.createNote', 'Create note')}
                        className={
                          platform
                            ? 'mt-2 min-h-12 items-center justify-center rounded-[10px] bg-brand px-4 py-2'
                            : 'mt-2 h-10 items-center justify-center rounded-[10px] bg-brand px-4'
                        }
                        style={({ pressed }) => ({
                          borderCurve: 'continuous',
                          opacity: pressed ? 0.85 : 1,
                        })}
                      >
                        <Text className="text-[15px] font-semibold text-white">
                          {copy('library.createNote', '+ Create Note')}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </GroupedList.Row>
              </GroupedList>
            </View>
          ) : (
            buckets.map((bucket) => (
              <View key={bucket.key}>
                <SectionHeader label={bucket.label} />
                <GroupedList dividerInset={16}>
                  {bucket.notes.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      bucket={bucket.key}
                      onPress={() => handleNotePress(note.id)}
                      onLongPress={() => move.open(note.id)}
                      onDelete={(restoreRow) => handleDeleteNote(note.id, restoreRow)}
                      onMove={() => move.open(note.id)}
                    />
                  ))}
                </GroupedList>
              </View>
            ))
          )}
        </ScrollView>

        <Fab
          icon="plus"
          mdIcon="Plus"
          accessibilityLabel={copy('library.create', 'Create')}
          actions={platform ? platform.translateFabActions(fabActions, t) : fabActions}
          onActionPress={handleFabAction}
        />

        {rename?.sheet}
        <NewFolderSheet
          visible={newFolderVisible}
          onClose={() => setNewFolderVisible(false)}
          onCreate={handleCreateFolderInSpace}
        />

        <MoveToFolderSheet {...move.sheetProps} />
      </View>
    );
  };
}
