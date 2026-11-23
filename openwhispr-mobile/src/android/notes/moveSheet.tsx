import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Folder, Note } from '@/data/types';
import type { Space } from '@/data/spacesTypes';
import { canMoveBetweenSpaces } from '@/lib/spacePermissions';
import { AppFont } from '@/lib/fonts';
import { safeHaptics } from '@/lib/utils';
import { useNotesStore } from '@/store/useNotesStore';
import { home } from '../home/kit';
import { BottomSheet, showToast, TextAction } from '../settings/kit';
import { edgeField } from '../settings/look';
import { GlassButton } from '../processingFable/look';
import { Card, ListRow, SectionLabel, SpaceTile, notesLook, sheetList } from './look';
import { workspacesOf } from './library';
import { notesT, useNotesT } from './strings';

/** Undo stays on the Moved toast this long (Figma N4). */
export const MOVE_UNDO_MS = 6000;
/** With more teamspaces than this, they fold into rows that open in place, under a search (N2b). */
const FLAT_TEAMSPACES = 2;

type Place = { space: Space; folderId: number | null };

/** Where a note can go: its own space's folders, and any space desktop's rule lets it move to. */
export function useMovePlaces(note: Note | null) {
  const spaces = useNotesStore((s) => s.spaces);
  const privateFolders = useNotesStore((s) => s.folders);
  const spaceFolders = useNotesStore((s) => s.spaceFolders);
  const getSpaceFolders = useNotesStore((s) => s.getSpaceFolders);
  const folderCounts = useNotesStore((s) => s.folderCounts);
  const privateSpace = spaces.find((space) => space.kind === 'private') ?? null;
  const from = note?.spaceId != null ? spaces.find((space) => space.id === note.spaceId) : null;
  const current = from ?? (note?.spaceId == null ? privateSpace : null);
  const reachable = useMemo(() => {
    if (!current) return [];
    return spaces.filter(
      (space) =>
        space.id === current.id || (space.kind === 'team' && canMoveBetweenSpaces(current, space)),
    );
  }, [current, spaces]);
  const foldersOf = useCallback(
    (space: Space): Folder[] =>
      space.kind === 'private' ? privateFolders : getSpaceFolders(space.id),
    // The store's lists stand in for "the repository changed" (create, rename, sync).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getSpaceFolders, privateFolders, spaceFolders],
  );
  return { current, reachable, foldersOf, folderCounts };
}

/**
 * Moves the note and shows N4's toast at the bottom with Undo for 6 s. Undo puts it back only
 * where desktop's rule allows, so a note shared into a teamspace never lands back in Private.
 */
export function moveNoteWithUndo(note: Note, from: Place, to: Place, label: string) {
  const store = useNotesStore.getState();
  const apply = (place: Place) => {
    const sameSpace = (note.spaceId ?? from.space.id) === place.space.id;
    if (!sameSpace || place.folderId == null) store.moveNoteToSpace(note.id, place.space.id);
    if (place.folderId != null) store.moveNoteToFolder(note.id, place.folderId);
  };
  apply(to);
  safeHaptics('success');
  const canUndo = from.space.id === to.space.id || canMoveBetweenSpaces(to.space, from.space);
  const message =
    from.space.id !== to.space.id && to.space.kind === 'team'
      ? notesT('sharedWith', { space: to.space.name })
      : notesT('movedTo', { folder: label });
  showToast(
    message,
    'neutral',
    canUndo
      ? {
          label: notesT('undo'),
          onPress: () => {
            const store = useNotesStore.getState();
            if (from.space.id !== to.space.id || from.folderId == null)
              store.moveNoteToSpace(note.id, from.space.id);
            if (from.folderId != null) store.moveNoteToFolder(note.id, from.folderId);
          },
          onClose: () => undefined,
        }
      : undefined,
    { durationMs: MOVE_UNDO_MS },
  );
}

/**
 * N2 / N2b: the #F2F1EF sheet. New folder first, then Private's folders with the current one
 * ticked and note counts, then teamspaces. Tapping a folder moves the note; there's no confirm.
 */
export function MoveToFolderSheet({
  visible,
  note,
  onClose,
}: {
  visible: boolean;
  note: Note | null;
  onClose: () => void;
}) {
  const t = useNotesT();
  const { height } = useWindowDimensions();
  const { current, reachable, foldersOf, folderCounts } = useMovePlaces(note);
  const createFolder = useNotesStore((s) => s.createFolder);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const nameInput = useRef<TextInput>(null);
  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setCreating(false);
    setName('');
    // The teamspace holding the note starts open.
    setOpen(current?.kind === 'team' ? { [current.id]: true } : {});
  }, [visible, current?.id, current?.kind]);
  useEffect(() => {
    if (!creating) return;
    const timer = setTimeout(() => nameInput.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [creating]);

  const privateSpace = reachable.find((space) => space.kind === 'private') ?? null;
  const teamspaces = reachable.filter((space) => space.kind === 'team');
  const folded = teamspaces.length > FLAT_TEAMSPACES;
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const from: Place | null = current ? { space: current, folderId: note?.folderId ?? null } : null;

  const pick = (space: Space, folder: Folder | null) => {
    onClose();
    if (!note || !from) return;
    if (from.space.id === space.id && from.folderId === (folder?.id ?? null)) return;
    moveNoteWithUndo(
      note,
      from,
      { space, folderId: folder?.id ?? null },
      folder?.name ?? space.name,
    );
  };

  const folderRow = (space: Space, folder: Folder, inset = false) => {
    const count = t('notesCount', { count: folderCounts[folder.id] ?? 0 });
    const selected = from?.space.id === space.id && from.folderId === folder.id;
    return (
      <View key={folder.id} style={inset ? { paddingLeft: 34 } : undefined}>
        <ListRow
          icon="Folder"
          iconColor={home.secondary}
          title={folder.name}
          subtitle={
            space.kind === 'team' ? t('seenBy', { notes: count, space: space.name }) : count
          }
          chevron={false}
          checked={selected}
          onPress={() => pick(space, folder)}
        />
      </View>
    );
  };
  const rootRow = (space: Space, inset = false) => (
    <View key={`root-${space.id}`} style={inset ? { paddingLeft: 34 } : undefined}>
      <ListRow
        icon="Inbox"
        iconColor={home.secondary}
        title={t('intoSpace', { space: space.name })}
        subtitle={t('noFolderInSpace')}
        chevron={false}
        checked={from?.space.id === space.id && from.folderId == null}
        onPress={() => pick(space, null)}
      />
    </View>
  );

  if (creating) {
    const trimmed = name.trim();
    const place = current?.kind === 'team' ? current.name : t('private');
    const submit = () => {
      if (!trimmed || !note || !current || !from) return;
      const folder = createFolder(trimmed, current.kind === 'team' ? current.id : undefined);
      onClose();
      moveNoteWithUndo(note, from, { space: current, folderId: folder.id }, folder.name);
    };
    return (
      <BottomSheet visible={visible} onClose={onClose} title={t('newFolder')}>
        <View style={{ gap: 8 }}>
          <TextInput
            ref={nameInput}
            value={name}
            onChangeText={setName}
            accessibilityLabel={t('folderName')}
            placeholder={t('folderName')}
            placeholderTextColor={home.tertiary}
            returnKeyType="done"
            onSubmitEditing={submit}
            autoCapitalize="sentences"
            style={[
              edgeField,
              {
                minHeight: 48,
                paddingHorizontal: 14,
                fontSize: 17,
                color: home.text,
                fontFamily: AppFont.regular,
                borderColor: home.accent,
                borderWidth: 1.5,
              },
            ]}
          />
          <Text style={notesLook.rowSub}>{t('newFolderIn', { place })}</Text>
        </View>
        <GlassButton label={t('createAndMove')} onPress={submit} disabled={!trimmed} />
        <TextAction label={t('backToFolders')} onPress={() => setCreating(false)} />
      </BottomSheet>
    );
  }

  const privateFolders = privateSpace ? foldersOf(privateSpace).filter((f) => matches(f.name)) : [];
  const sections: React.ReactNode[] = [];
  if (privateSpace && (privateFolders.length > 0 || !needle)) {
    sections.push(
      <View key="private" style={{ gap: 8 }}>
        <SectionLabel label={t('private')} />
        {privateFolders.length > 0 ? (
          <Card>{privateFolders.map((folder) => folderRow(privateSpace, folder))}</Card>
        ) : null}
      </View>,
    );
  }
  if (folded) {
    const rowOf = (space: Space) => {
      const folders = foldersOf(space);
      const shown = matches(space.name) ? folders : folders.filter((f) => matches(f.name));
      if (needle && shown.length === 0 && !matches(space.name)) return null;
      const expanded = Boolean(needle) || open[space.id];
      return (
        <View key={space.id}>
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setOpen((state) => ({ ...state, [space.id]: !state[space.id] }))}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingLeft: 14,
              paddingRight: 14,
              paddingVertical: 12,
              minHeight: 60,
              backgroundColor: pressed ? 'rgba(0,0,0,0.04)' : 'transparent',
            })}
          >
            <SpaceTile emoji={space.emoji} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={notesLook.rowTitle}>
                {space.name}
              </Text>
              <Text numberOfLines={1} style={notesLook.rowSub}>
                {[
                  space.memberCount ? t('membersCount', { count: space.memberCount }) : null,
                  t('foldersCount', { count: folders.length }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <SystemIcon
              name="circle"
              mdName={expanded ? 'ChevronUp' : 'ChevronDown'}
              size={20}
              color={home.secondary}
            />
          </Pressable>
          {expanded
            ? [
                ...(shown.length === 0 ? [rootRow(space, true)] : []),
                ...shown.map((folder) => folderRow(space, folder, true)),
              ]
            : null}
        </View>
      );
    };
    // One group per workspace, headed by its name (Figma W): a private note can go to any.
    for (const workspace of workspacesOf(teamspaces)) {
      const rows = workspace.teams.map(rowOf).filter(Boolean);
      if (rows.length === 0) continue;
      sections.push(
        <View key={`workspace-${workspace.id}`} style={{ gap: 8 }}>
          <SectionLabel
            label={
              workspace.name ? t('workspaceTeamspaces', { name: workspace.name }) : t('teamspaces')
            }
          />
          <Card>{rows}</Card>
        </View>,
      );
    }
  } else {
    for (const space of teamspaces) {
      const folders = foldersOf(space).filter((f) => matches(f.name) || matches(space.name));
      sections.push(
        <View key={space.id} style={{ gap: 8 }}>
          <SectionLabel label={space.name} />
          <Card>
            {folders.length > 0
              ? folders.map((folder) => folderRow(space, folder))
              : rootRow(space)}
          </Card>
        </View>,
      );
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('moveToFolder')}>
      <ScrollView
        style={[sheetList.style, { maxHeight: height * 0.68 }]}
        contentContainerStyle={[sheetList.content, { gap: 16 }]}
        keyboardShouldPersistTaps="handled"
      >
        {folded ? (
          <View
            style={[
              edgeField,
              {
                borderRadius: 999,
                minHeight: 48,
                paddingHorizontal: 16,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
              },
            ]}
          >
            <SystemIcon name="magnifyingglass" mdName="Search" size={18} color={home.secondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              accessibilityLabel={t('searchFolders')}
              placeholder={t('searchFolders')}
              placeholderTextColor={home.tertiary}
              returnKeyType="search"
              style={{
                flex: 1,
                fontSize: 16,
                color: home.text,
                fontFamily: AppFont.regular,
                paddingVertical: 10,
              }}
            />
          </View>
        ) : null}
        <Card>
          <ListRow
            icon="FolderPlus"
            title={t('newFolder')}
            accent
            chevron={false}
            onPress={() => setCreating(true)}
          />
        </Card>
        {sections}
        {needle && sections.length === 0 ? (
          <Text style={[notesLook.rowSub, { textAlign: 'center' }]}>
            {t('nothingMatches', { query: query.trim() })}
          </Text>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}
