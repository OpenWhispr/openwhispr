import React, { useEffect, useMemo, useState } from 'react';
import { BackHandler, Pressable, RefreshControl, ScrollView, Share, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import type { Folder, Note } from '@/data';
import { useNotesStore } from '@/store/useNotesStore';
import { useNoteBuckets } from '@/hooks/useNoteBuckets';
import { useManualSyncRefresh } from '@/hooks/useManualSyncRefresh';
import { safeHaptics } from '@/lib/utils';
import { getNotesRouteOwner, withNotesRouteOwner } from '@/lib/notes/noteRouteOwner';
import { home } from '../home/kit';
import { look } from '../settings/look';
import { BottomSheet, useSettingsToast } from '../settings/kit';
import { useNavigationBar } from '../navigationBar';
import {
  Card,
  IconButton,
  LinkButton,
  ListRow,
  NewButton,
  NotesHeader,
  SectionLabel,
  goBack,
  notesLook,
} from './look';
import {
  notesInWorkspace,
  privateSpaceId,
  useAllNotes,
  useLibraryRevision,
  useCurrentWorkspace,
} from './library';
import { NoteRow, SwipeRow } from './rows';
import { deleteNotesWithUndo } from './pendingDeletes';
import { NewSheet } from './sheets';
import { useUpNext } from './calendar';
import { startNote, startUpload } from './start';
import { useMeetingStart } from './meetingStart';
import { useNotesT } from './strings';

/**
 * Figma L1b, a folder: back, the folder's name, search inside it, its notes by day. Also the
 * Recent list and a teamspace with no folders. Long-press selects (L4), swipe left deletes
 * (L9), and every delete is a 6 s Undo toast (D1).
 */
export default function FolderNotes() {
  const t = useNotesT();
  const params = useLocalSearchParams<{
    folderId?: string;
    spaceId?: string;
    recent?: string;
    dataOwner?: string;
  }>();
  // A route opened under another account (or before one was bound) never shows this account's
  // folder that happens to share its id: it goes back to the Notes root instead.
  const staleOwner =
    (params.folderId != null || params.spaceId != null) &&
    (getNotesRouteOwner() === undefined || params.dataOwner !== getNotesRouteOwner());
  const folderId = params.folderId && !staleOwner ? Number(params.folderId) : null;
  const spaceId = params.spaceId && !staleOwner ? Number(params.spaceId) : null;
  const recent = params.recent === '1';
  const { folders, spaces, isInitialized, initialize, moveNoteToFolder } = useNotesStore();
  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);
  const revision = useLibraryRevision();
  const allNotes = useAllNotes(revision);
  const { current: workspace } = useCurrentWorkspace();
  const privateId = useMemo(() => privateSpaceId(), []);

  const folder = useMemo<Folder | null>(() => {
    if (folderId == null) return null;
    const own = folders.find((value) => value.id === folderId);
    if (own) return own;
    for (const space of spaces) {
      const match = useNotesStore
        .getState()
        .getSpaceFolders(space.id)
        .find((value) => value.id === folderId);
      if (match) return match;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId, folders, spaces, revision]);
  const space = spaceId != null ? spaces.find((value) => value.id === spaceId) : null;

  const notes = useMemo(() => {
    if (recent) return notesInWorkspace(allNotes, workspace, privateId);
    if (folderId != null) return allNotes.filter((note) => note.folderId === folderId);
    // W3: a teamspace lists its folders first, then the notes in no folder.
    if (spaceId != null)
      return allNotes.filter((note) => note.spaceId === spaceId && note.folderId == null);
    return [];
  }, [allNotes, recent, folderId, spaceId, workspace, privateId]);
  const spaceFolders = useMemo(
    () => (spaceId != null && !recent ? useNotesStore.getState().getSpaceFolders(spaceId) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaceId, recent, revision],
  );
  const folderCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const note of allNotes)
      if (note.folderId != null) map.set(note.folderId, (map.get(note.folderId) ?? 0) + 1);
    return map;
  }, [allNotes]);
  const openFolder = (target: Folder) => {
    safeHaptics('selection');
    router.push({
      pathname: '/(tabs)/(notes)/notes',
      params: withNotesRouteOwner({ folderId: String(target.id) }),
    });
  };
  const buckets = useNoteBuckets(notes);
  const title = recent ? t('recent') : (folder?.name ?? space?.name ?? t('notes'));

  // A folder deleted elsewhere (another device, a sync pass) leaves nothing to show.
  useEffect(() => {
    if (staleOwner || (isInitialized && folderId != null && !folder)) goBack();
  }, [staleOwner, isInitialized, folderId, folder]);

  const { refreshing, onRefresh } = useManualSyncRefresh();
  const { next, now } = useUpNext();
  const [newVisible, setNewVisible] = useState(false);
  const [selected, setSelected] = useState<number[] | null>(null);
  const [moving, setMoving] = useState<number[] | null>(null);
  const selecting = selected !== null;
  // The Undo toast sits where New floats; New steps aside until it closes (Figma D1).
  const undoShowing = useSettingsToast((state) => state.action != null);

  // L4: the action bar replaces the tab bar while selecting.
  const navigation = useNavigation();
  useEffect(() => {
    const tabs = navigation.getParent();
    tabs?.setOptions({ tabBarStyle: selecting ? { display: 'none' } : undefined });
    return () => tabs?.setOptions({ tabBarStyle: undefined });
  }, [navigation, selecting]);
  useEffect(() => {
    if (!selecting) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelected(null);
      return true;
    });
    return () => sub.remove();
  }, [selecting]);

  const place = { folderId: folder?.id, spaceId: folder ? undefined : (spaceId ?? undefined) };
  const meeting = useMeetingStart(place);
  const open = (note: Note) => {
    safeHaptics('selection');
    router.push(`/(tabs)/(notes)/${note.id}`);
  };
  const toggle = (id: number) => {
    safeHaptics('selection');
    setSelected((current) => {
      if (!current) return [id];
      const next = current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];
      return next.length ? next : null;
    });
  };
  const remove = (ids: number[]) => {
    const first = notes.find((note) => note.id === ids[0]);
    safeHaptics('warning');
    deleteNotesWithUndo(ids, first?.title ?? undefined);
    setSelected(null);
  };
  const share = (ids: number[]) => {
    const text = notes
      .filter((note) => ids.includes(note.id))
      .map((note) => {
        const body = note.enhancedContent?.trim() || note.content?.trim() || '';
        return `${note.title?.trim() || t('untitled')}\n\n${body}`.trim();
      })
      .join('\n\n---\n\n');
    Share.share({ message: text }).catch(() => undefined);
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={{ flex: 1, backgroundColor: notesLook.canvas }}
    >
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingBottom: selecting ? 24 : 104,
          gap: 12,
          flexGrow: 1,
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {selecting ? (
          <SelectHeader count={selected.length} onClose={() => setSelected(null)} />
        ) : (
          <NotesHeader
            back
            title={title}
            right={
              <IconButton
                icon="Search"
                label={t('search')}
                onPress={() =>
                  router.push({
                    pathname: '/android-notes-search',
                    params: folder ? { folderId: String(folder.id) } : {},
                  })
                }
              />
            }
          />
        )}
        {spaceFolders.length > 0 && !selecting ? (
          <View style={{ gap: 12 }}>
            <SectionLabel label={t('folders')} />
            <Card>
              {spaceFolders.map((value) => (
                <ListRow
                  key={value.id}
                  icon="Folder"
                  title={value.name}
                  value={String(folderCounts.get(value.id) ?? 0)}
                  onPress={() => openFolder(value)}
                />
              ))}
            </Card>
          </View>
        ) : null}
        {buckets.length === 0 && spaceFolders.length > 0 ? null : buckets.length === 0 ? (
          <EmptyFolder
            name={title}
            onWrite={() => startNote(place.folderId)}
            onUpload={() => startUpload(place)}
          />
        ) : (
          buckets.map((bucket) => (
            <View key={bucket.key} style={{ gap: 12 }}>
              <SectionLabel label={bucket.label} />
              <Card>
                {bucket.notes.map((note) => (
                  <SwipeRow
                    key={note.id}
                    noteId={note.id}
                    enabled={!selecting}
                    onDelete={() => remove([note.id])}
                    onMove={() => setMoving([note.id])}
                  >
                    <NoteRow
                      note={note}
                      selectMode={selecting}
                      selected={selected?.includes(note.id)}
                      onPress={() => (selecting ? toggle(note.id) : open(note))}
                      onLongPress={() => toggle(note.id)}
                    />
                  </SwipeRow>
                ))}
              </Card>
            </View>
          ))
        )}
      </ScrollView>
      {selecting ? (
        <ActionBar
          onMove={() => setMoving(selected)}
          onShare={() => share(selected)}
          onDelete={() => remove(selected)}
        />
      ) : undoShowing ? null : (
        <NewButton onPress={() => setNewVisible(true)} bottom={16} />
      )}
      <NewSheet
        visible={newVisible}
        onClose={() => setNewVisible(false)}
        nextEvent={next ?? null}
        now={now}
        onRecord={() => {
          setNewVisible(false);
          meeting.open();
        }}
        onRecordEvent={(event) => {
          setNewVisible(false);
          meeting.open(event);
        }}
        onWrite={() => {
          setNewVisible(false);
          startNote(place.folderId);
        }}
        onUpload={() => {
          setNewVisible(false);
          startUpload(place);
        }}
      />
      {meeting.sheet}
      <MoveSheet
        ids={moving}
        fromFolderId={folderId}
        onClose={() => setMoving(null)}
        onPick={(target) => {
          for (const id of moving ?? []) moveNoteToFolder(id, target.id);
          safeHaptics('success');
          setMoving(null);
          setSelected(null);
        }}
        notes={notes}
      />
    </SafeAreaView>
  );
}

function SelectHeader({ count, onClose }: { count: number; onClose: () => void }) {
  const t = useNotesT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 47 }}>
      <IconButton icon="X" label={t('close')} onPress={onClose} color={home.accent} />
      <Text
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
        style={[notesLook.rowTitle, { flex: 1, textAlign: 'center', marginRight: 36 }]}
      >
        {t('selected', { count })}
      </Text>
    </View>
  );
}

/** L4's bar: Move, Share and Delete (red) in place of the tab bar. */
function ActionBar({
  onMove,
  onShare,
  onDelete,
}: {
  onMove: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const t = useNotesT();
  const { inset } = useNavigationBar();
  const item = (
    icon: LucideIconName,
    label: string,
    onPress: () => void,
    color: string = home.text,
  ) => (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 64,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <SystemIcon name="circle" mdName={icon} size={22} color={color} />
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        paddingTop: 8,
        paddingBottom: 8 + inset,
        backgroundColor: home.surface,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        borderTopWidth: 1,
        borderColor: look.hairline,
      }}
    >
      {item('Folder', t('move'), onMove)}
      {item('Share', t('share'), onShare)}
      {item('Trash2', t('delete'), onDelete, look.error)}
    </View>
  );
}

/** Move one or more notes to another folder in the same space. */
function MoveSheet({
  ids,
  fromFolderId,
  notes,
  onClose,
  onPick,
}: {
  ids: number[] | null;
  fromFolderId: number | null;
  notes: Note[];
  onClose: () => void;
  onPick: (folder: Folder) => void;
}) {
  const t = useNotesT();
  const folders = useNotesStore((state) => state.folders);
  const first = notes.find((note) => note.id === ids?.[0]);
  const targets = useMemo(() => {
    const spaceId = first?.spaceId ?? null;
    const privateId = privateSpaceId();
    const pool =
      spaceId == null || spaceId === privateId
        ? folders
        : useNotesStore.getState().getSpaceFolders(spaceId);
    return pool.filter((folder) => folder.id !== fromFolderId);
  }, [first, folders, fromFolderId]);
  return (
    <BottomSheet visible={ids != null} onClose={onClose} title={t('move')}>
      <Card>
        {targets.map((folder) => (
          <ListRow
            key={folder.id}
            icon="Folder"
            title={folder.name}
            chevron={false}
            onPress={() => onPick(folder)}
          />
        ))}
      </Card>
    </BottomSheet>
  );
}

function EmptyFolder({
  name,
  onWrite,
  onUpload,
}: {
  name: string;
  onWrite: () => void;
  onUpload: () => void;
}) {
  const t = useNotesT();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
      <Text style={[notesLook.rowTitle, { textAlign: 'center' }]}>
        {t('emptyFolder', { folder: name })}
      </Text>
      <Text style={[notesLook.rowSub, { textAlign: 'center', fontSize: 15, lineHeight: 21 }]}>
        {t('emptyFolderBody')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
        <LinkButton label={t('writeNote')} onPress={onWrite} />
        <LinkButton label={t('uploadAudio')} onPress={onUpload} />
      </View>
    </View>
  );
}
