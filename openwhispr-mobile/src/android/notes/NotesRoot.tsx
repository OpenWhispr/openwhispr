import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useScrollToTop } from '@react-navigation/native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Folder } from '@/android/shared/data';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { useNotesStore } from '@/android/store/useNotesStore';
import { useManualSyncRefresh } from '@/android/shared/hooks/useManualSyncRefresh';
import { withNotesRouteOwner } from '@/lib/notes/noteRouteOwner';
import { safeHaptics } from '@/android/shared/lib/utils';
import { useNavigationBarCanvas } from '../navigationBar';
import { useTheme } from '../ThemeProvider';
import { useTabColors } from '../tabBar';
import { useSettingsToast } from '../settings/kit';
import {
  Card,
  IconButton,
  LinkButton,
  ListRow,
  NewButton,
  NoteTile,
  NotesHeader,
  SectionLabel,
  SpaceTile,
  useNotesLook,
} from './look';
import {
  defaultFolderFor,
  setNotesWorkspace,
  useAllNotes,
  useCurrentWorkspace,
  useLibraryRevision,
} from './library';
import { FolderNameSheet, NewSheet, TodaySheet, WorkspaceSheet } from './sheets';
import { useLoadWorkspaces } from './workspaceList';
import { eventIsNow, hideUpNext, minutesUntil, useUpNext } from './calendar';
import { startNote, startUpload } from './start';
import { useMeetingStart } from './meetingStart';
import { CalendarPrompt } from './CalendarPrompt';
import { useFolderMenu } from './folderMenu';
import { useNotesT } from './strings';

/**
 * Figma W1 (one workspace: Private's folders, then its teamspaces), W2 (the workspace picker),
 * L2 (empty) and L5–L8 (calendar).
 */
export default function NotesRoot() {
  const t = useNotesT();
  const n = useNotesLook();
  const scroll = useRef<ScrollView>(null);
  useScrollToTop(scroll);
  useNavigationBarCanvas(useTabColors().bar);
  const { folders, isInitialized, initialize, createFolder } = useNotesStore();
  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);
  const revision = useLibraryRevision();
  const allNotes = useAllNotes(revision);
  const { workspaces, current } = useCurrentWorkspace();
  useLoadWorkspaces();
  // Counted from the notes themselves, so a note waiting out its Undo isn't counted.
  const counts = useMemo(() => {
    const map = new Map<number, number>();
    for (const note of allNotes)
      if (note.folderId != null) map.set(note.folderId, (map.get(note.folderId) ?? 0) + 1);
    return map;
  }, [allNotes]);
  const spaceCounts = useMemo(() => {
    const map = new Map<number, number>();
    for (const note of allNotes)
      if (note.spaceId != null) map.set(note.spaceId, (map.get(note.spaceId) ?? 0) + 1);
    return map;
  }, [allNotes]);
  const { refreshing, onRefresh } = useManualSyncRefresh();
  const { next, events, now } = useUpNext();
  const folderMenu = useFolderMenu();
  // The Undo toast sits where New floats; New steps aside until it closes (Figma D1).
  const undoShowing = useSettingsToast((state) => state.action != null);

  const [newVisible, setNewVisible] = useState(false);
  const [workspacesVisible, setWorkspacesVisible] = useState(false);
  const [todayVisible, setTodayVisible] = useState(false);
  const [newFolderVisible, setNewFolderVisible] = useState(false);

  const targetFolder = defaultFolderFor(folders);
  // "OpenWhispr teamspaces" (Figma W1, W4).
  const teamspacesLabel = current.name
    ? t('workspaceTeamspaces', { name: current.name })
    : t('teamspaces');
  const empty = allNotes.length === 0;

  const openFolder = (folder: Folder) => {
    safeHaptics('selection');
    router.push({
      pathname: '/(tabs)/(notes)/notes',
      params: withNotesRouteOwner({ folderId: String(folder.id) }),
    });
  };
  const openSpace = (spaceId: number) => {
    safeHaptics('selection');
    router.push({
      pathname: '/(tabs)/(notes)/notes',
      params: withNotesRouteOwner({ spaceId: String(spaceId) }),
    });
  };
  const openSearch = () => router.push('/android-notes-search');
  const meeting = useMeetingStart({ folderId: targetFolder });
  // R0: every way to record goes through the Start sheet; L5 and L7 name the meeting.
  const recordEvent = (event: GoogleCalendarEvent | null | undefined) => {
    setNewVisible(false);
    setTodayVisible(false);
    meeting.open(event);
  };

  if (empty && !refreshing) {
    return (
      <Page>
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <NotesHeader title={t('notes')} />
        </View>
        <EmptyNotes
          onRecord={() => recordEvent(undefined)}
          onWrite={() => startNote(targetFolder)}
          onUpload={() => startUpload({ folderId: targetFolder })}
        />
        {meeting.sheet}
      </Page>
    );
  }

  return (
    <Page>
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: 104, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[n.accent]}
            progressBackgroundColor={n.surface}
            tintColor={n.accent}
          />
        }
      >
        <NotesHeader
          title={t('notes')}
          onTitlePress={workspaces.length > 1 ? () => setWorkspacesVisible(true) : undefined}
          titleHint={t('workspace')}
          right={<IconButton icon="Search" label={t('search')} onPress={openSearch} />}
        />
        {/* L5 needs a connected calendar; until then (and until ×) C1 asks for one. */}
        <CalendarPrompt />
        {next ? (
          <UpNextCard
            event={next}
            now={now}
            more={events.filter((event) => event.id !== next.id).length}
            onRecord={() => recordEvent(next)}
            onMore={() => setTodayVisible(true)}
            onHide={() => hideUpNext(next.id)}
          />
        ) : null}
        {folders.length > 0 ? (
          <>
            <SectionLabel label={t('private')} />
            <Card>
              {folders.map((folder) => (
                <ListRow
                  key={folder.id}
                  icon="Folder"
                  title={folder.name}
                  value={String(counts.get(folder.id) ?? 0)}
                  onPress={() => openFolder(folder)}
                  onLongPress={() => folderMenu.open(folder, false)}
                />
              ))}
            </Card>
          </>
        ) : null}
        {current.teams.length === 0 && current.id != null ? (
          <>
            <SectionLabel label={teamspacesLabel} />
            <EmptyTeamspaces />
          </>
        ) : null}
        {current.teams.length > 0 ? (
          <>
            <SectionLabel label={teamspacesLabel} />
            <Card>
              {current.teams.map((space) => (
                <ListRow
                  key={space.id}
                  tile={<SpaceTile emoji={space.emoji} />}
                  title={space.name}
                  value={String(spaceCounts.get(space.id) ?? 0)}
                  onPress={() => openSpace(space.id)}
                />
              ))}
            </Card>
          </>
        ) : null}
      </ScrollView>
      {undoShowing ? null : <NewButton onPress={() => setNewVisible(true)} bottom={16} />}
      <NewSheet
        visible={newVisible}
        onClose={() => setNewVisible(false)}
        nextEvent={next ?? null}
        now={now}
        onRecord={() => recordEvent(undefined)}
        onRecordEvent={recordEvent}
        onWrite={() => {
          setNewVisible(false);
          startNote(targetFolder);
        }}
        onUpload={() => {
          setNewVisible(false);
          startUpload({ folderId: targetFolder });
        }}
        onNewFolder={() => {
          setNewVisible(false);
          setNewFolderVisible(true);
        }}
      />
      <WorkspaceSheet
        visible={workspacesVisible}
        onClose={() => setWorkspacesVisible(false)}
        workspaces={workspaces}
        currentId={current.id}
        onPick={(workspaceId) => {
          safeHaptics('selection');
          setNotesWorkspace(workspaceId);
          setWorkspacesVisible(false);
          scroll.current?.scrollTo({ y: 0, animated: false });
        }}
      />
      <TodaySheet
        visible={todayVisible}
        onClose={() => setTodayVisible(false)}
        events={events}
        now={now}
        onRecord={recordEvent}
      />
      <FolderNameSheet
        visible={newFolderVisible}
        onClose={() => setNewFolderVisible(false)}
        title={t('newFolder')}
        submitLabel={t('newFolder')}
        onSubmit={(name) => createFolder(name)}
      />
      {folderMenu.sheets}
      {meeting.sheet}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  const n = useNotesLook();
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: n.canvas }}>
      {children}
    </SafeAreaView>
  );
}

// Desktop's empty shared-space illustration (src/assets/empty-states/notes-shared-space-light.svg)
// at 3x. Pre-rendered because Android's SVG renderer drops its filter and clips the middle tile.
const EMPTY_TEAMSPACES = require('./assets/empty-teamspaces.png');

/**
 * W4: a workspace where you're in no teamspace. Teamspaces are created and managed on desktop, so
 * there's nothing to do here but wait for one to be shared.
 */
function EmptyTeamspaces() {
  const t = useNotesT();
  const n = useNotesLook();
  return (
    <View
      style={[n.edgeCard, { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 24 }]}
    >
      <Image
        source={EMPTY_TEAMSPACES}
        style={{ width: 134, height: 139 }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
      <Text style={[n.rowTitle, { marginTop: 8, textAlign: 'center' }]}>
        {t('noTeamspacesTitle')}
      </Text>
      <Text style={[n.rowSub, { marginTop: 4, textAlign: 'center' }]}>{t('noTeamspacesBody')}</Text>
    </View>
  );
}

/** L2: one big round glass mic with a soft halo, and two quiet links. */
function EmptyNotes({
  onRecord,
  onWrite,
  onUpload,
}: {
  onRecord: () => void;
  onWrite: () => void;
  onUpload: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const { glass, glassPressed } = useTheme();
  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}
    >
      <View
        style={{
          width: 168,
          height: 168,
          borderRadius: 84,
          backgroundColor: n.selectedRow,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('tapToRecord')}
          onPress={onRecord}
          style={({ pressed }) => [
            {
              width: 120,
              height: 120,
              borderRadius: 60,
              alignItems: 'center',
              justifyContent: 'center',
            },
            glass,
            pressed && glassPressed,
          ]}
        >
          <SystemIcon name="mic" mdName="Mic" size={40} color={n.onGlass} />
        </Pressable>
      </View>
      <Text
        style={{
          marginTop: 32,
          fontSize: 20,
          lineHeight: 26,
          fontWeight: '500',
          color: n.text,
          textAlign: 'center',
        }}
      >
        {t('tapToRecord')}
      </Text>
      <Text
        style={{
          marginTop: 12,
          fontSize: 15,
          lineHeight: 21,
          color: n.secondary,
          textAlign: 'center',
        }}
      >
        {t('tapToRecordBody')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 24 }}>
        <LinkButton label={t('writeNote')} onPress={onWrite} />
        <LinkButton label={t('uploadAudio')} onPress={onUpload} />
      </View>
    </View>
  );
}

/** L5: the next meeting, from an hour before it until it ends. */
function UpNextCard({
  event,
  now,
  more,
  onRecord,
  onMore,
  onHide,
}: {
  event: GoogleCalendarEvent;
  now: number;
  more: number;
  onRecord: () => void;
  onMore: () => void;
  onHide: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const { glass, glassPressed } = useTheme();
  const label = eventIsNow(event, now)
    ? `${t('upNext')} · ${t('now')}`
    : `${t('upNext')} · ${t('inMinutes', { count: minutesUntil(event, now) })}`;
  return (
    <View
      style={[
        n.edgeCard,
        { flexDirection: 'row', gap: 12, paddingLeft: 14, paddingRight: 12, paddingVertical: 12 },
      ]}
    >
      <NoteTile icon="Calendar" />
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            fontSize: 11,
            lineHeight: 15,
            fontWeight: '500',
            letterSpacing: 0.66,
            color: n.accent,
          }}
        >
          {label.toUpperCase()}
        </Text>
        <Text numberOfLines={1} style={n.rowTitle}>
          {event.summary?.trim() || t('recordMeeting')}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
          {more > 0 ? (
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              onPress={onMore}
              hitSlop={8}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 2,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontSize: 13, lineHeight: 18, color: n.accent }}>
                {t('moreToday', { count: more })}
              </Text>
              <SystemIcon name="chevron.right" mdName="ChevronRight" size={14} color={n.accent} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('hideUpNext')}
          onPress={onHide}
          hitSlop={10}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <SystemIcon name="xmark" mdName="X" size={16} color={n.tertiary} />
        </Pressable>
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          onPress={onRecord}
          style={({ pressed }) => [
            {
              height: 40,
              paddingHorizontal: 16,
              borderRadius: 999,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            },
            glass,
            pressed && glassPressed,
          ]}
        >
          <SystemIcon name="mic" mdName="Mic" size={16} color={n.onGlass} />
          <Text style={{ color: n.onGlass, fontSize: 15, lineHeight: 20, fontWeight: '500' }}>
            {t('record')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
