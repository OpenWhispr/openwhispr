import { useEffect, useCallback, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, RefreshControl, Alert, ActionSheetIOS } from 'react-native';
import { Text } from '@/components/ui/Text';

const SCROLL_PADDING = 16;
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useNotesStore } from '@/store/useNotesStore';
import { NotesTopBar } from '@/components/notes/NotesTopBar';
import { GroupedList } from '@/components/notes/GroupedList';
import { FolderRow } from '@/components/notes/FolderRow';
import { NoteRow } from '@/components/notes/NoteRow';
import { SectionHeader } from '@/components/notes/SectionHeader';
import { MoveToFolderSheet } from '@/components/notes/MoveToFolderSheet';
import { NewFolderSheet } from '@/components/notes/NewFolderSheet';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { Fab, FAB_BOTTOM_PADDING, type FabAction } from '@/components/ui/Fab';
import { groupNotesByDate } from '@/lib/groupNotesByDate';
import { canMoveBetweenSpaces } from '@/lib/spacePermissions';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { SyncStatusLabel } from '@/components/notes/SyncStatusLabel';
import { VoiceProfilePromptCard } from '@/components/notes/VoiceProfilePromptCard';
import { useSyncStore } from '@/sync/useSyncStore';
import { requestSync } from '@/sync/syncEngine';
import { useConfigStore } from '@/store/useConfigStore';

export default function NotesListScreen() {
  const params = useLocalSearchParams<{ folderId?: string; spaceId?: string }>();
  const folderId = params.folderId ? Number(params.folderId) : null;
  const spaceId = params.spaceId ? Number(params.spaceId) : null;

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
    moveNoteToFolder,
    moveNoteToSpace,
    createFolder,
    renameFolder,
    deleteFolderSafe,
    voiceProfiles,
    loadVoiceProfiles,
  } = useNotesStore();
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const [movingNoteId, setMovingNoteId] = useState<number | null>(null);
  const [newFolderVisible, setNewFolderVisible] = useState(false);

  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);

  useEffect(() => {
    loadVoiceProfiles();
  }, [loadVoiceProfiles]);

  useFocusEffect(
    useCallback(() => {
      // Only re-assert when the store drifted to another scope — descending into
      // a folder rewrites it, so coming back would otherwise leave this screen
      // showing the child's notes. A no-op refocus (returning from a note) must
      // not run, or it would clear an open search.
      const { activeFolderId: storeFolderId, activeSpaceId: storeSpaceId } =
        useNotesStore.getState();
      if (spaceId != null) {
        if (storeSpaceId !== spaceId) setActiveSpaceId(spaceId);
      } else if (storeFolderId !== folderId) {
        setActiveFolderId(folderId);
      }
    }, [folderId, spaceId, setActiveFolderId, setActiveSpaceId]),
  );

  const activeFolder =
    folderId != null
      ? (folders.find((f) => f.id === folderId) ?? spaceFolders.find((f) => f.id === folderId))
      : null;
  const activeSpace = spaceId != null ? spaces.find((s) => s.id === spaceId) : null;
  const screenTitle = activeSpace?.name ?? activeFolder?.name ?? 'Notes';

  // The space this screen's content belongs to — set both when browsing a space
  // and when browsing one of its folders, so move targets never cross scopes.
  const contentSpaceId = useMemo(
    () => spaceId ?? spaceFolders.find((f) => f.id === folderId)?.spaceId ?? null,
    [spaceId, folderId, spaceFolders],
  );
  const moveTargetFolders = contentSpaceId != null ? spaceFolders : folders;

  // Where this note is allowed to go, by desktop's rule: personal content may
  // move to any team space, while team content stays inside its own workspace —
  // never back to the private space, and never across workspaces.
  const moveTargetSpaces = useMemo(() => {
    const from =
      contentSpaceId != null
        ? spaces.find((s) => s.id === contentSpaceId)
        : spaces.find((s) => s.kind === 'private');
    if (!from) return [];
    return spaces.filter(
      (space) => space.kind === 'team' && space.id !== from.id && canMoveBetweenSpaces(from, space),
    );
  }, [spaces, contentSpaceId]);

  const buckets = useMemo(() => groupNotesByDate(notes), [notes]);
  const totalCount = useMemo(() => {
    if (spaceId == null) return notes.length;
    return (
      notes.length + spaceFolders.reduce((sum, folder) => sum + (folderCounts[folder.id] ?? 0), 0)
    );
  }, [spaceId, notes.length, spaceFolders, folderCounts]);

  // Folders replace the empty state while browsing a space, but a search must
  // still be able to report "no results".
  const showSpaceFolders = spaceId != null && spaceFolders.length > 0 && !searchQuery;

  const syncStatus = useSyncStore((s) => s.status);
  const onRefresh = useCallback(() => {
    requestSync('manual');
  }, []);

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

  const openMoveSheet = useCallback((noteId: number) => {
    safeHaptics('medium');
    setMovingNoteId(noteId);
  }, []);

  const closeMoveSheet = useCallback(() => setMovingNoteId(null), []);

  const handlePickFolder = useCallback(
    (targetFolderId: number) => {
      if (movingNoteId != null) {
        moveNoteToFolder(movingNoteId, targetFolderId);
        safeHaptics('success');
      }
      setMovingNoteId(null);
    },
    [movingNoteId, moveNoteToFolder],
  );

  const handleCreateAndPick = useCallback(
    (name: string) => {
      const folder = createFolder(name, contentSpaceId ?? undefined);
      if (movingNoteId != null) {
        moveNoteToFolder(movingNoteId, folder.id);
      }
      setMovingNoteId(null);
    },
    [movingNoteId, createFolder, moveNoteToFolder, contentSpaceId],
  );

  const handlePickSpace = useCallback(
    (targetSpaceId: number) => {
      if (movingNoteId != null) {
        moveNoteToSpace(movingNoteId, targetSpaceId);
        safeHaptics('success');
      }
      setMovingNoteId(null);
    },
    [movingNoteId, moveNoteToSpace],
  );

  const handleCompose = useCallback(() => {
    const note = createNote();
    router.push(`/(tabs)/(notes)/${note.id}`);
  }, [createNote]);

  const goToFolder = useCallback((targetFolderId: number) => {
    safeHaptics('selection');
    router.push({
      pathname: '/(tabs)/(notes)/notes',
      params: { folderId: String(targetFolderId) },
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
    if (spaceId != null) {
      actions.push({
        id: 'folder',
        label: 'New Folder',
        icon: 'folder.badge.plus',
        mdIcon: 'FolderPlus',
      });
    }
    return actions;
  }, [spaceId]);

  // Deleting a space folder tombstones its notes for everyone in the space, so
  // the server allows it to admins only (requireSpaceFolderAdmin). Renaming has
  // no such restriction — any member with write access may.
  const canDeleteSpaceFolders = activeSpace?.myRole === 'admin';

  const handleSpaceFolderLongPress = useCallback(
    (targetFolderId: number, folderName: string, isDefault: number | null) => {
      safeHaptics('medium');
      // The server refuses to delete a default folder outright, so never offer it.
      const canDelete = canDeleteSpaceFolders && !isDefault;
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
    [canDeleteSpaceFolders, renameFolder, deleteFolderSafe, folderCounts],
  );

  const handleFabAction = useCallback(
    (id: string) => {
      if (id === 'note') {
        handleCompose();
      } else if (id === 'meeting') {
        router.push('/(tabs)/(notes)/meeting-record');
      } else if (id === 'folder') {
        safeHaptics('light');
        setNewFolderVisible(true);
      }
    },
    [handleCompose],
  );

  const hasOwnerProfile = voiceProfiles.some((profile) => profile.isOwner === 1);
  const showVoiceProfilePrompt = !hasOwnerProfile && !config?.voiceProfilePromptDismissedAt;

  const openVoiceProfiles = useCallback(() => {
    safeHaptics('selection');
    router.push('/(tabs)/(notes)/voice-profiles');
  }, []);

  const openOwnerEnrollment = useCallback(() => {
    safeHaptics('selection');
    router.push('/(tabs)/(notes)/voice-enrollment?owner=1');
  }, []);

  const dismissVoiceProfilePrompt = useCallback(() => {
    safeHaptics('light');
    updateConfig({ voiceProfilePromptDismissedAt: new Date().toISOString() });
  }, [updateConfig]);

  return (
    <View className="flex-1 bg-systemBackground">
      <NotesTopBar
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
        refreshControl={
          <RefreshControl refreshing={syncStatus === 'running'} onRefresh={onRefresh} />
        }
      >
        <Text className="mb-2 text-[15px] text-tertiaryLabel">{`${totalCount} ${totalCount === 1 ? 'Note' : 'Notes'}`}</Text>
        <SyncStatusLabel />
        <VoiceProfilePromptCard
          visible={showVoiceProfilePrompt && !searchQuery}
          onEnroll={openOwnerEnrollment}
          onDismiss={dismissVoiceProfilePrompt}
        />

        <View className="mb-2">
          <GroupedList>
            <GroupedList.Row
              leadingIconSlot={
                <SystemIcon name="waveform" mdName="AudioLines" size={22} color="brand" />
              }
              onPress={openVoiceProfiles}
              accessibilityRole="button"
              accessibilityLabel="Voice Profiles"
            >
              <View className="flex-row items-center justify-between gap-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-[16px] font-medium text-label">Voice Profiles</Text>
                  <Text className="mt-0.5 text-[13px] text-secondaryLabel">
                    {voiceProfiles.length === 0
                      ? 'Enroll voices for meeting labels'
                      : `${voiceProfiles.length} enrolled`}
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

        {showSpaceFolders && (
          <View className="mb-2">
            <SectionHeader label="Folders" />
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
                      {`No results for "${searchQuery}"`}
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
                        No notes here yet
                      </Text>
                      <Text className="text-[15px] text-tertiaryLabel">
                        Create your first note to start writing
                      </Text>
                    </View>
                    <Pressable
                      onPress={handleCompose}
                      accessibilityRole="button"
                      accessibilityLabel="Create note"
                      className="mt-2 h-10 items-center justify-center rounded-[10px] bg-brand px-4"
                      style={({ pressed }) => ({
                        borderCurve: 'continuous',
                        opacity: pressed ? 0.85 : 1,
                      })}
                    >
                      <Text className="text-[15px] font-semibold text-white">+ Create Note</Text>
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
                    onLongPress={() => openMoveSheet(note.id)}
                    onDelete={() => handleDeleteNote(note.id)}
                    onMove={() => openMoveSheet(note.id)}
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
        accessibilityLabel="Create"
        actions={fabActions}
        onActionPress={handleFabAction}
      />

      <NewFolderSheet
        visible={newFolderVisible}
        onClose={() => setNewFolderVisible(false)}
        onCreate={handleCreateFolderInSpace}
      />

      <MoveToFolderSheet
        visible={movingNoteId != null}
        folders={moveTargetFolders}
        folderCounts={folderCounts}
        excludeFolderId={activeFolderId}
        onClose={closeMoveSheet}
        onPickFolder={handlePickFolder}
        onCreateAndPick={handleCreateAndPick}
        spaces={moveTargetSpaces}
        activeSpaceId={contentSpaceId}
        onPickSpace={handlePickSpace}
      />
    </View>
  );
}
