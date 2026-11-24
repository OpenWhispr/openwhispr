import React, { useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import type { GoogleCalendarEvent } from '@/data/calendarTypes';
import { AppFont } from '@/lib/fonts';
import { BottomSheet } from '../settings/kit';
import { GlassButton } from '../processingFable/look';
import { Card, LinkButton, ListRow, NoteTile, useNotesLook } from './look';
import { eventIsNow, eventTimeRange, minutesUntil } from './calendar';
import { timeOf } from './rows';
import { useNotesT } from './strings';
import type { Workspace } from './library';
import { parseCalendarParticipants } from '@/lib/calendar/meetingContext';
import { MeetingModelList, MeetingModelRow } from './meetingModelSheet';

/** A row with a tile, a title and a line under it; used by every sheet here. */
function SheetRow({
  icon,
  title,
  subtitle,
  onPress,
  tint,
}: {
  icon: LucideIconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
  tint?: boolean;
}) {
  const n = useNotesLook();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 14,
        paddingRight: 12,
        paddingVertical: 12,
        minHeight: 64,
        backgroundColor: pressed ? n.pressedRow : 'transparent',
      })}
    >
      {tint ? (
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            backgroundColor: n.selFill,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <SystemIcon name="circle" mdName={icon} size={20} color={n.accent} />
        </View>
      ) : (
        <NoteTile icon={icon} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={n.rowTitle}>{title}</Text>
        {subtitle ? <Text style={n.rowSub}>{subtitle}</Text> : null}
      </View>
    </Pressable>
  );
}

/** N1 (and L8 with a meeting coming up): the three ways in, and New folder under them. */
export function NewSheet({
  visible,
  onClose,
  onRecord,
  onRecordEvent,
  onWrite,
  onUpload,
  onNewFolder,
  nextEvent,
  now,
}: {
  visible: boolean;
  onClose: () => void;
  onRecord: () => void;
  onRecordEvent: (event: GoogleCalendarEvent) => void;
  onWrite: () => void;
  onUpload: () => void;
  onNewFolder?: () => void;
  nextEvent: GoogleCalendarEvent | null;
  now: number;
}) {
  const t = useNotesT();
  const eventTitle = nextEvent?.summary?.trim() || t('recordMeeting');
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('new')}>
      <Card>
        {nextEvent ? (
          <SheetRow
            tint
            icon="Mic"
            title={t('recordEvent', { title: `“${eventTitle}”` })}
            subtitle={
              eventIsNow(nextEvent, now)
                ? `${t('now')} · ${eventTimeRange(nextEvent)}`
                : `${timeOf(nextEvent.startAt)} · ${t('inMinutes', {
                    count: minutesUntil(nextEvent, now),
                  }).toLowerCase()}`
            }
            onPress={() => onRecordEvent(nextEvent)}
          />
        ) : null}
        <SheetRow
          icon="Mic"
          title={t(nextEvent ? 'recordAnother' : 'recordMeeting')}
          subtitle={t('recordMeetingBody')}
          onPress={onRecord}
        />
        <SheetRow
          icon="SquarePen"
          title={t('writeNote')}
          subtitle={t('writeNoteBody')}
          onPress={onWrite}
        />
        <SheetRow
          icon="FileUp"
          title={t('uploadAudio')}
          subtitle={t('uploadAudioBody')}
          onPress={onUpload}
        />
      </Card>
      {onNewFolder ? (
        <View style={{ paddingHorizontal: 4 }}>
          <LinkButton label={t('newFolder')} icon="FolderPlus" onPress={onNewFolder} />
        </View>
      ) : null}
    </BottomSheet>
  );
}

/** W2: the workspaces you're in, the current one ticked; picking one switches Notes. */
export function WorkspaceSheet({
  visible,
  onClose,
  workspaces,
  currentId,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  workspaces: Workspace[];
  currentId: string | null;
  onPick: (workspaceId: string | null) => void;
}) {
  const t = useNotesT();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('workspace')}>
      <Card>
        {workspaces.map((workspace) => (
          <ListRow
            key={workspace.id ?? 'none'}
            icon="Users"
            title={workspace.name || t('teamspaces')}
            subtitle={t('privatePlusTeams', { count: workspace.teams.length })}
            chevron={false}
            selected={workspace.id === currentId}
            onPress={() => onPick(workspace.id)}
          />
        ))}
      </Card>
    </BottomSheet>
  );
}

/** L7: today's meetings, each with Record. */
export function TodaySheet({
  visible,
  onClose,
  events,
  now,
  onRecord,
}: {
  visible: boolean;
  onClose: () => void;
  events: GoogleCalendarEvent[];
  now: number;
  onRecord: (event: GoogleCalendarEvent) => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('todaySheet')}>
      <Card>
        {events.map((event) => {
          const guests = (parseCalendarParticipants(event.attendeesJson) ?? []).filter(
            (person) => !person.resource,
          ).length;
          const when = eventIsNow(event, now)
            ? t('now')
            : Date.parse(event.startAt) - now <= 60 * 60 * 1000
              ? `${timeOf(event.startAt)} · ${t('inMinutes', {
                  count: minutesUntil(event, now),
                }).toLowerCase()}`
              : timeOf(event.startAt);
          return (
            <View
              key={event.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingLeft: 16,
                paddingRight: 8,
                paddingVertical: 10,
                minHeight: 64,
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text numberOfLines={1} style={n.rowTitle}>
                  {event.summary?.trim() || t('recordMeeting')}
                </Text>
                <Text style={n.rowSub}>
                  {guests > 1 ? `${when} · ${t('people', { count: guests })}` : when}
                </Text>
              </View>
              <Pressable
                cssInterop={false}
                accessibilityRole="button"
                accessibilityLabel={`${t('record')} ${event.summary ?? ''}`}
                onPress={() => onRecord(event)}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: 12,
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ color: n.accent, fontSize: 16, fontWeight: '500' }}>
                  {t('record')}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </Card>
    </BottomSheet>
  );
}

/** New folder and Rename folder: one field and a glass button. */
export function FolderNameSheet({
  visible,
  onClose,
  initialName,
  title,
  submitLabel,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  initialName?: string;
  title: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
}) {
  const n = useNotesLook();
  const [name, setName] = useState(initialName ?? '');
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!visible) return;
    setName(initialName ?? '');
    const timer = setTimeout(() => input.current?.focus(), 280);
    return () => clearTimeout(timer);
  }, [visible, initialName]);
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <TextInput
        ref={input}
        value={name}
        onChangeText={setName}
        placeholder={title}
        placeholderTextColor={n.tertiary}
        returnKeyType="done"
        onSubmitEditing={submit}
        autoCapitalize="sentences"
        style={[
          n.edgeField,
          {
            minHeight: 48,
            paddingHorizontal: 14,
            fontSize: 17,
            color: n.text,
            fontFamily: AppFont.regular,
          },
        ]}
      />
      <GlassButton label={submitLabel} onPress={submit} disabled={!trimmed} />
    </BottomSheet>
  );
}

/**
 * R0: what will be recorded and where it runs, then one glass Start recording. The meeting
 * row names the calendar event found (tap to pick another or none); Change goes to Processing.
 */
export function StartSheet({
  visible,
  onClose,
  events,
  event,
  onPickEvent,
  onDevice,
  keyName,
  needsModel,
  now,
  onChange,
  onStart,
  onModelsChanged,
}: {
  visible: boolean;
  onClose: () => void;
  events: GoogleCalendarEvent[];
  event: GoogleCalendarEvent | null;
  onPickEvent: (event: GoogleCalendarEvent | null) => void;
  onDevice: boolean;
  /** The provider of the key saved for meetings (Settings → Processing → Meetings), if any. */
  keyName?: string | null;
  /** No speech model that can transcribe meetings is on the phone (On device only). */
  needsModel: boolean;
  now: number;
  onChange: () => void;
  onStart: () => void;
  /** A model finished downloading on the sheet: read what the meeting needs again. */
  onModelsChanged?: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const [picking, setPicking] = useState(false);
  const [choosingModel, setChoosingModel] = useState(false);
  useEffect(() => {
    if (!visible) {
      setPicking(false);
      setChoosingModel(false);
    }
  }, [visible]);
  if (choosingModel)
    return (
      <BottomSheet
        visible={visible}
        onClose={onClose}
        title={t('meetingModelListTitle')}
        onBack={() => setChoosingModel(false)}
      >
        <MeetingModelList
          onModelReady={() => {
            setChoosingModel(false);
            onModelsChanged?.();
          }}
        />
      </BottomSheet>
    );
  const people = event
    ? (parseCalendarParticipants(event.attendeesJson) ?? []).filter((person) => !person.resource)
        .length
    : 0;
  const when = event
    ? eventIsNow(event, now)
      ? t('now')
      : `${timeOf(event.startAt)} · ${t('inMinutes', { count: minutesUntil(event, now) }).toLowerCase()}`
    : '';
  if (picking)
    return (
      <BottomSheet
        visible={visible}
        onClose={onClose}
        title={t('pickEvent')}
        onBack={() => setPicking(false)}
      >
        <Card>
          {events.map((value) => (
            <ListRow
              key={value.id}
              icon="Calendar"
              title={value.summary?.trim() || t('recordMeeting')}
              subtitle={eventIsNow(value, now) ? t('now') : timeOf(value.startAt)}
              chevron={false}
              selected={event?.id === value.id}
              onPress={() => {
                onPickEvent(value);
                setPicking(false);
              }}
            />
          ))}
          <ListRow
            icon="CalendarX"
            iconColor={n.secondary}
            title={t('noEvent')}
            subtitle={t('noEventBody')}
            chevron={false}
            selected={event == null}
            onPress={() => {
              onPickEvent(null);
              setPicking(false);
            }}
          />
        </Card>
      </BottomSheet>
    );
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('recordMeeting')}>
      <Card>
        {events.length > 0 ? (
          <ListRow
            icon="Calendar"
            title={event ? event.summary?.trim() || t('recordMeeting') : t('noEvent')}
            subtitle={
              event
                ? [when, 'Google Calendar', people > 1 ? t('people', { count: people }) : null]
                    .filter(Boolean)
                    .join(' · ')
                : t('noEventBody')
            }
            onPress={() => setPicking(true)}
          />
        ) : null}
        <ListRow
          icon={onDevice ? 'Smartphone' : keyName ? 'KeyRound' : 'Cloud'}
          title={onDevice ? t('onPhone') : (keyName ?? t('liveOnCloud'))}
          subtitle={t(onDevice ? 'onPhoneBody' : 'liveOnCloudBody')}
          chevron={false}
          right={
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              onPress={onChange}
              hitSlop={8}
              style={({ pressed }) => ({ paddingHorizontal: 4, opacity: pressed ? 0.6 : 1 })}
            >
              <Text style={{ color: n.accent, fontSize: 16, fontWeight: '600' }}>
                {t('change')}
              </Text>
            </Pressable>
          }
        />
        {onDevice ? (
          <MeetingModelRow
            needsModel={needsModel}
            onChoose={() => setChoosingModel(true)}
            onLanded={() => onModelsChanged?.()}
          />
        ) : null}
      </Card>
      <Text style={{ fontSize: 13, lineHeight: 18, color: n.secondary }}>{t('startFooter')}</Text>
      <GlassButton
        label={t('startRecording')}
        onPress={onStart}
        disabled={onDevice && needsModel}
      />
    </BottomSheet>
  );
}
