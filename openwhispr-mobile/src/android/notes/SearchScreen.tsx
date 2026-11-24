import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { notesRepository } from '@/data';
import type { Note } from '@/data';
import { useNotesStore } from '@/store/useNotesStore';
import { SearchField } from '../controls';
import { safeHaptics } from '@/lib/utils';
import { useNavigationBarCanvas } from '../navigationBar';
import { BackButton, Card, Chip, SectionLabel, useNotesLook } from './look';
import {
  notesInWorkspace,
  privateSpaceId,
  useAllNotes,
  useLibraryRevision,
  useCurrentWorkspace,
} from './library';
import { NoteRow, dayOf, kindLabel } from './rows';
import {
  forgetSearch,
  loadRecentSearches,
  rememberSearch,
  searchNotes,
  useRecentSearches,
  type MatchPlace,
  type SearchHit,
} from './search';
import { useNotesT, type NotesKey } from './strings';

const PLACE_LABEL: Record<MatchPlace, NotesKey> = {
  title: 'matchTitle',
  notes: 'matchNotes',
  summary: 'matchSummary',
  transcript: 'matchTranscript',
};

/** Figma 3e: S1 recent searches, S2 results with folder chips, S3 nothing found. */
export default function SearchScreen() {
  const t = useNotesT();
  const n = useNotesLook();
  useNavigationBarCanvas(n.canvas);
  const params = useLocalSearchParams<{ folderId?: string }>();
  const startFolder = params.folderId ? Number(params.folderId) : null;
  const [query, setQuery] = useState('');
  const [settled, setSettled] = useState('');
  const [folderFilter, setFolderFilter] = useState<number | null>(startFolder);
  const input = useRef<TextInput>(null);
  const recents = useRecentSearches((state) => state.items);
  useEffect(loadRecentSearches, []);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const revision = useLibraryRevision();
  const allNotes = useAllNotes(revision);
  const { current: workspace } = useCurrentWorkspace();
  const spaces = useNotesStore((state) => state.spaces);
  const folders = useNotesStore((state) => state.folders);
  const privateId = useMemo(() => privateSpaceId(), []);
  const scoped = useMemo(
    () => notesInWorkspace(allNotes, workspace, privateId),
    [allNotes, workspace, privateId],
  );
  const transcripts = useRef(new Map<number, string>());
  const hits = useMemo(
    () =>
      searchNotes(scoped, settled, (note: Note) => {
        const cached = transcripts.current.get(note.id);
        if (cached !== undefined) return cached;
        let text = '';
        try {
          text = notesRepository
            .getSegments(note.id)
            .map((segment) => segment.text)
            .join(' ');
        } catch {
          text = '';
        }
        transcripts.current.set(note.id, text);
        return text;
      }),
    [scoped, settled],
  );

  const folderNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const folder of folders) names.set(folder.id, folder.name);
    for (const space of spaces)
      if (space.kind === 'team')
        for (const folder of useNotesStore.getState().getSpaceFolders(space.id))
          names.set(folder.id, folder.name);
    return names;
  }, [folders, spaces]);
  // Chips name the folders the results are in; the folder search started from stays first.
  const chipFolders = useMemo(() => {
    const ids: number[] = [];
    if (startFolder != null) ids.push(startFolder);
    for (const hit of hits)
      if (hit.note.folderId != null && !ids.includes(hit.note.folderId))
        ids.push(hit.note.folderId);
    return ids.filter((id) => folderNames.has(id));
  }, [hits, startFolder, folderNames]);
  const shown =
    folderFilter == null ? hits : hits.filter((hit) => hit.note.folderId === folderFilter);

  const place =
    folderFilter != null
      ? (folderNames.get(folderFilter) ?? t('private'))
      : workspace.teams.length > 0 && workspace.name
        ? workspace.name
        : t('everywhere');

  const openHit = (hit: SearchHit) => {
    safeHaptics('selection');
    rememberSearch(settled);
    const tab =
      hit.place === 'summary' ? 'summary' : hit.place === 'transcript' ? 'transcript' : 'notes';
    router.push({
      pathname: '/(tabs)/(notes)/[id]',
      params: { id: String(hit.note.id), ...(hit.place === 'title' ? {} : { tab }) },
    });
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={{ flex: 1, backgroundColor: n.canvas }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: 4,
        }}
      >
        <BackButton />
        <SearchField
          ref={input}
          autoFocus
          value={query}
          onChangeText={setQuery}
          placeholder={t('searchNotes')}
          clearLabel={t('clear')}
          onSubmitEditing={() => rememberSearch(query)}
          style={{ flex: 1 }}
        />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
      >
        {!settled ? (
          recents.length > 0 ? (
            <>
              <SectionLabel label={t('recentSearches')} />
              <Card>
                {recents.map((item) => (
                  <RecentRow
                    key={item}
                    label={item}
                    onPress={() => setQuery(item)}
                    onRemove={() => forgetSearch(item)}
                  />
                ))}
              </Card>
            </>
          ) : null
        ) : shown.length === 0 && hits.length === 0 ? (
          <View
            style={{ flex: 1, alignItems: 'center', paddingTop: 96, paddingHorizontal: 24, gap: 8 }}
          >
            <SystemIcon name="magnifyingglass" mdName="Search" size={28} color={n.tertiary} />
            <Text style={[n.rowTitle, { textAlign: 'center', marginTop: 8 }]}>
              {t('noMatch', { query: settled })}
            </Text>
            <Text style={[n.rowSub, { textAlign: 'center', fontSize: 14, lineHeight: 20 }]}>
              {t('noMatchBody', { place })}
            </Text>
          </View>
        ) : (
          <>
            {chipFolders.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                // The chips' shadows need room: the row scrolls, the page doesn't clip them.
                style={{ marginHorizontal: -16, overflow: 'visible', flexGrow: 0 }}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingVertical: 6,
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <Chip
                  label={t('all')}
                  selected={folderFilter == null}
                  onPress={() => setFolderFilter(null)}
                />
                {chipFolders.map((id) => (
                  <Chip
                    key={id}
                    label={folderNames.get(id) ?? ''}
                    selected={folderFilter === id}
                    onPress={() => setFolderFilter(id)}
                  />
                ))}
              </ScrollView>
            ) : null}
            <SectionLabel label={t('resultCount', { count: shown.length })} />
            {shown.length > 0 ? (
              <Card>
                {shown.map((hit) => (
                  <NoteRow
                    key={hit.note.id}
                    note={hit.note}
                    onPress={() => openHit(hit)}
                    detail={<HitLine hit={hit} />}
                    meta={`${kindLabel(hit.note, t)} · ${dayOf(hit.note.updatedAt, t)}`}
                  />
                ))}
              </Card>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** "Summary · Ship the video before the **pricing** page." */
function HitLine({ hit }: { hit: SearchHit }) {
  const t = useNotesT();
  const n = useNotesLook();
  const label = t(PLACE_LABEL[hit.place]);
  if (hit.place === 'title') {
    const preview = (hit.note.enhancedContent || hit.note.content || '').replace(/\s+/g, ' ');
    return (
      <Text numberOfLines={1} style={n.rowSub}>
        {label}
        {preview ? ` · ${preview.slice(0, 80)}` : ''}
      </Text>
    );
  }
  const before = hit.snippet.slice(0, hit.start);
  const match = hit.snippet.slice(hit.start, hit.start + hit.length);
  const after = hit.snippet.slice(hit.start + hit.length);
  return (
    <Text numberOfLines={2} style={n.rowSub}>
      {label} · {before}
      <Text style={[n.rowSub, { color: n.text, fontWeight: '700' }]}>{match}</Text>
      {after}
    </Text>
  );
}

function RecentRow({
  label,
  onPress,
  onRemove,
}: {
  label: string;
  onPress: () => void;
  onRemove: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 48 }}>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingLeft: 16,
          paddingVertical: 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <SystemIcon name="clock" mdName="RotateCcw" size={18} color={n.secondary} />
        <Text numberOfLines={1} style={{ fontSize: 17, lineHeight: 22, color: n.text }}>
          {label}
        </Text>
      </Pressable>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        accessibilityLabel={t('removeSearch', { query: label })}
        onPress={onRemove}
        style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}
      >
        <SystemIcon name="xmark" mdName="X" size={16} color={n.tertiary} />
      </Pressable>
    </View>
  );
}
