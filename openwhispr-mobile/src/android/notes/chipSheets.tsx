import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import type { CalendarParticipant, GoogleCalendarEvent } from '@/data/calendarTypes';
import { AppFont } from '@/android/shared/lib/fonts';
import { BottomSheet } from '../settings/kit';
import { GlassButton } from '../processingFable/look';
import { SearchField } from '../controls';
import { Card, ListRow, NoteTile, SectionLabel, sheetList, useNotesLook } from './look';
import { eventTimeRange } from './calendar';
import { initialsOf } from './initials';
import {
  eventPeople,
  groupByDay,
  hostOf,
  meetingUrlOf,
  personFromEmail,
  sameDay,
  suggestPeople,
} from './noteMeta';
import { useNotesT } from './strings';

function Avatar({ text, size = 36 }: { text: string; size?: number }) {
  const n = useNotesLook();
  return (
    <View
      style={[
        n.edge,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '600', color: n.text }}>{text}</Text>
    </View>
  );
}

function PersonRow({
  title,
  subtitle,
  initials,
  trailing,
  onPress,
  label,
}: {
  title: string;
  subtitle?: string | null;
  initials: string;
  trailing?: { icon: LucideIconName; label: string; onPress: () => void; accent?: boolean };
  onPress?: () => void;
  label?: string;
}) {
  const n = useNotesLook();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 14,
        paddingRight: trailing ? 4 : 14,
        paddingVertical: 10,
        minHeight: 64,
        backgroundColor: pressed && onPress ? n.pressedRow : 'transparent',
      })}
    >
      <Avatar text={initials} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={n.rowTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={n.rowSub}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={trailing.label}
          onPress={trailing.onPress}
          hitSlop={4}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <SystemIcon
            name="circle"
            mdName={trailing.icon}
            size={trailing.accent ? 20 : 18}
            color={trailing.accent ? n.accent : n.secondary}
          />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const nameOf = (person: CalendarParticipant) => person.displayName || person.email || '';

/**
 * N5: the note's people. Add people first, then everyone with initials, the organizer marked and
 * you last. × takes someone off this note only (the editor offers Undo); it never touches the
 * calendar. N6, Add people, is a page of the same sheet.
 */
export function PeopleSheet({
  visible,
  onClose,
  people,
  viewer,
  candidates,
  workspace,
  viewerEmail,
  onQueryChange,
  onRemove,
  onAdd,
  startAdding,
}: {
  visible: boolean;
  onClose: () => void;
  /** Everyone on the note but you. */
  people: CalendarParticipant[];
  /** You, when the note is yours: "You · Took these notes". */
  viewer: { initials: string } | null;
  candidates: CalendarParticipant[];
  /** People in your workspace matching what's typed; they're suggested first. */
  workspace: CalendarParticipant[];
  viewerEmail: string | null;
  onQueryChange: (query: string) => void;
  onRemove: (person: CalendarParticipant) => void;
  onAdd: (people: CalendarParticipant[]) => void;
  /** N1b's Add people chip opens straight on N6. */
  startAdding?: boolean;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const { height } = useWindowDimensions();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CalendarParticipant[]>([]);
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!visible) return;
    setAdding(Boolean(startAdding));
    setQuery('');
    onQueryChange('');
    setPicked([]);
  }, [visible, startAdding]);
  useEffect(() => {
    if (!adding) return;
    const timer = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [adding]);

  if (adding) {
    const onNote = [...people, ...picked];
    const { typedEmail, people: suggestions } = suggestPeople(query, candidates, onNote, {
      workspace,
      viewerEmail,
    });
    const search = (text: string) => {
      setQuery(text);
      onQueryChange(text);
    };
    const add = (person: CalendarParticipant) => {
      setPicked((list) => [...list, person]);
      search('');
    };
    const done = () => {
      if (picked.length > 0) onAdd(picked);
      if (startAdding || people.length === 0) onClose();
      else setAdding(false);
    };
    return (
      <BottomSheet
        visible={visible}
        onClose={onClose}
        title={t('addPeople')}
        onBack={startAdding ? undefined : () => setAdding(false)}
      >
        <View
          style={[
            n.edgeField,
            {
              minHeight: 48,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              borderColor: n.accent,
              borderWidth: 1.5,
            },
          ]}
        >
          <SystemIcon name="circle" mdName="Users" size={18} color={n.secondary} />
          <TextInput
            ref={input}
            value={query}
            onChangeText={search}
            accessibilityLabel={t('nameOrEmail')}
            placeholder={t('nameOrEmail')}
            placeholderTextColor={n.tertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            returnKeyType="done"
            onSubmitEditing={() => {
              if (typedEmail) add(personFromEmail(typedEmail));
            }}
            style={{
              flex: 1,
              fontSize: 17,
              color: n.text,
              fontFamily: AppFont.regular,
              paddingVertical: 10,
            }}
          />
        </View>
        <ScrollView
          style={[sheetList.style, { maxHeight: height * 0.34 }]}
          contentContainerStyle={[sheetList.content, { gap: 12 }]}
          keyboardShouldPersistTaps="handled"
        >
          {picked.length > 0 ? (
            <Card>
              {picked.map((person) => (
                <PersonRow
                  key={person.email ?? nameOf(person)}
                  title={nameOf(person)}
                  subtitle={person.displayName ? person.email : null}
                  initials={initialsOf(nameOf(person))}
                  trailing={{
                    icon: 'Check',
                    accent: true,
                    label: t('removePerson', { name: nameOf(person) }),
                    onPress: () => setPicked((list) => list.filter((other) => other !== person)),
                  }}
                />
              ))}
            </Card>
          ) : null}
          {typedEmail || suggestions.length > 0 ? (
            <Card>
              {typedEmail ? (
                <PersonRow
                  key="typed"
                  title={t('addEmail', { email: typedEmail })}
                  initials={initialsOf(typedEmail)}
                  onPress={() => add(personFromEmail(typedEmail))}
                  trailing={{
                    icon: 'Plus',
                    accent: true,
                    label: t('addEmail', { email: typedEmail }),
                    onPress: () => add(personFromEmail(typedEmail)),
                  }}
                />
              ) : null}
              {suggestions.map((person) => (
                <PersonRow
                  key={person.email ?? nameOf(person)}
                  title={nameOf(person)}
                  subtitle={person.displayName ? person.email : null}
                  initials={initialsOf(nameOf(person))}
                  onPress={() => add(person)}
                  trailing={{
                    icon: 'Plus',
                    accent: true,
                    label: t('addPerson', { name: nameOf(person) }),
                    onPress: () => add(person),
                  }}
                />
              ))}
            </Card>
          ) : null}
        </ScrollView>
        <GlassButton label={t('done')} onPress={done} />
      </BottomSheet>
    );
  }

  const count = people.length + (viewer ? 1 : 0);
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('peopleTitle', { count })}>
      <ScrollView
        style={[sheetList.style, { maxHeight: height * 0.66 }]}
        contentContainerStyle={[sheetList.content, { gap: 12 }]}
      >
        <Card>
          <ListRow
            icon="Plus"
            title={t('addPeople')}
            accent
            chevron={false}
            onPress={() => setAdding(true)}
          />
        </Card>
        <Card>
          {people.map((person) => (
            <PersonRow
              key={person.email ?? nameOf(person)}
              title={nameOf(person)}
              subtitle={
                person.organizer
                  ? person.email && person.displayName
                    ? t('organizerEmail', { email: person.email })
                    : t('organizer')
                  : person.displayName
                    ? person.email
                    : null
              }
              initials={initialsOf(nameOf(person))}
              trailing={{
                icon: 'X',
                label: t('removePerson', { name: nameOf(person) }),
                onPress: () => onRemove(person),
              }}
            />
          ))}
          {viewer ? (
            <PersonRow title={t('you')} subtitle={t('tookNotes')} initials={viewer.initials} />
          ) : null}
        </Card>
      </ScrollView>
    </BottomSheet>
  );
}

const titleOf = (event: GoogleCalendarEvent, fallback: string) => event.summary?.trim() || fallback;

function dayLabel(date: Date, now: Date, today: string): string {
  const day = date
    .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(/,/g, '');
  return sameDay(date, now) ? `${today} · ${day}` : day;
}

function SheetAction({
  icon,
  title,
  subtitle,
  onPress,
  trailing,
  destructive,
}: {
  icon: LucideIconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
  trailing?: LucideIconName;
  destructive?: boolean;
}) {
  const n = useNotesLook();
  return (
    <ListRow
      icon={icon}
      iconColor={destructive ? undefined : n.text}
      title={title}
      subtitle={subtitle}
      chevron={false}
      destructive={destructive}
      onPress={onPress}
      right={
        trailing ? (
          <SystemIcon name="circle" mdName={trailing} size={18} color={n.secondary} />
        ) : undefined
      }
    />
  );
}

/**
 * N7: the linked meeting as the calendar has it, Join (only with a meeting link), Open in Google
 * Calendar, Change event and Unlink. N8, Link a calendar event, is a page of the same sheet:
 * the note's day first; search reaches the rest of the calendar window.
 */
export function EventSheet({
  visible,
  onClose,
  linked,
  event,
  joinUrl,
  events,
  noteDate,
  startPicking,
  onJoin,
  onOpen,
  onPick,
  onUnlink,
}: {
  visible: boolean;
  onClose: () => void;
  /** The note has a link, whether or not this phone's calendars have the event. */
  linked: boolean;
  event: GoogleCalendarEvent | null;
  /** A Meet link read from Google when the event's own text has none. */
  joinUrl?: string | null;
  events: GoogleCalendarEvent[];
  noteDate: Date;
  startPicking?: boolean;
  onJoin: (url: string) => void;
  onOpen: (url: string) => void;
  onPick: (event: GoogleCalendarEvent) => void;
  onUnlink: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const { height } = useWindowDimensions();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!visible) return;
    setPicking(Boolean(startPicking) || !linked);
    setQuery('');
  }, [visible, startPicking, linked]);
  const now = useMemo(() => new Date(), []);
  const needle = query.trim().toLowerCase();
  const shownDays = useMemo(() => {
    const matching = needle
      ? events.filter((value) => (value.summary ?? '').toLowerCase().includes(needle))
      : events.filter((value) => sameDay(new Date(value.startAt), noteDate));
    return groupByDay(matching);
  }, [events, needle, noteDate]);

  if (picking) {
    return (
      <BottomSheet
        visible={visible}
        onClose={onClose}
        title={t('linkCalendarEvent')}
        onBack={linked && !startPicking ? () => setPicking(false) : undefined}
      >
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t('searchEvents')}
          clearLabel={t('clear')}
        />
        <ScrollView
          style={[sheetList.style, { maxHeight: height * 0.5 }]}
          contentContainerStyle={[sheetList.content, { gap: 12 }]}
          keyboardShouldPersistTaps="handled"
        >
          {shownDays.length === 0 ? (
            <Text style={n.rowSub}>
              {needle ? t('nothingMatches', { query: query.trim() }) : t('noEventsThatDay')}
            </Text>
          ) : (
            shownDays.map((day) => (
              <View key={day.key} style={{ gap: 8 }}>
                <SectionLabel label={dayLabel(day.date, now, t('today'))} />
                <Card>
                  {day.events.map((value) => {
                    const guests = eventPeople(value).filter((person) => !person.self).length;
                    return (
                      <ListRow
                        key={value.id}
                        icon="Calendar"
                        iconColor={n.text}
                        title={titleOf(value, t('untitledEvent'))}
                        subtitle={
                          guests > 0
                            ? `${eventTimeRange(value)} · ${t('people', { count: guests })}`
                            : eventTimeRange(value)
                        }
                        chevron={false}
                        checked={event?.id === value.id}
                        onPress={() => onPick(value)}
                      />
                    );
                  })}
                </Card>
              </View>
            ))
          )}
        </ScrollView>
        <Text style={n.rowSub}>{t('eventsHint')}</Text>
      </BottomSheet>
    );
  }

  const url = meetingUrlOf(event) ?? joinUrl ?? null;
  const guests = event ? eventPeople(event).filter((person) => !person.self) : [];
  const guestNames = guests
    .slice(0, 2)
    .map((person) => (person.displayName || person.email || '').split(/[\s@]/)[0]);
  const when = event
    ? `${dayLabel(new Date(event.startAt), now, t('today')).split(' · ')[0]}, ${eventTimeRange(event)} · ${t('googleCalendar')}`
    : '';
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('calendarEvent')}>
      {event ? (
        <>
          <Card>
            <ListRow
              icon="Calendar"
              iconColor={n.text}
              title={titleOf(event, t('untitledEvent'))}
              subtitle={when}
              chevron={false}
            />
            {guests.length > 0 ? (
              <ListRow
                icon="Users"
                iconColor={n.text}
                title={t('people', { count: guests.length })}
                chevron={false}
                right={
                  <Text numberOfLines={1} style={[n.rowSub, { maxWidth: 140 }]}>
                    {guests.length > 2
                      ? `${guestNames.join(', ')} +${guests.length - 2}`
                      : guestNames.join(', ')}
                  </Text>
                }
              />
            ) : null}
          </Card>
          {url || event.htmlLink ? (
            <Card>
              {url ? (
                <SheetAction
                  icon="Link"
                  title={t('joinMeeting')}
                  subtitle={hostOf(url)}
                  trailing="ArrowUpRight"
                  onPress={() => onJoin(url)}
                />
              ) : null}
              {event.htmlLink ? (
                <SheetAction
                  icon="ArrowUpRight"
                  title={t('openInGoogle')}
                  onPress={() => onOpen(event.htmlLink!)}
                />
              ) : null}
            </Card>
          ) : null}
        </>
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <NoteTile icon="CalendarX" color={n.secondary} />
          <Text style={[n.rowSub, { flex: 1 }]}>{t('eventNotOnPhone')}</Text>
        </View>
      )}
      <Card>
        {event ? (
          <SheetAction icon="Calendar" title={t('changeEvent')} onPress={() => setPicking(true)} />
        ) : null}
        <SheetAction icon="X" title={t('unlinkEvent')} destructive onPress={onUnlink} />
      </Card>
    </BottomSheet>
  );
}
