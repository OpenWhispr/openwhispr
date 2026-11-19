import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SegmentedControl } from '@/components/ui/SegmentedControl.android';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import type { TranscriptBlock } from '@/lib/diarization/transcriptDisplay';
import { gloss, glossPressed, home } from '../home/kit';
import { edge, edgeCard, look } from '../settings/look';
import { useReduceMotion } from '../settings/kit';
import { BackButton, IconButton, LinkButton, notesLook } from './look';
import { initialsOf } from './initials';
import { useNotesT } from './strings';

/** E1's top row: back left, Share and ⋯ right. The title scrolls with the note below it. */
export function NoteTopBar({ onShare, onMore }: { onShare?: () => void; onMore: () => void }) {
  const t = useNotesT();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 4,
        minHeight: 52,
      }}
    >
      <BackButton />
      <View style={{ flex: 1 }} />
      {onShare ? <IconButton icon="Share" label={t('shareNote')} onPress={onShare} /> : null}
      <IconButton icon="Ellipsis" label={t('more')} onPress={onMore} />
    </View>
  );
}

/** A white meta chip with the glass edge: "Today, 10:00 · 32 min", "Meetings". */
export function MetaChip({
  icon,
  label,
  onPress,
  testID,
}: {
  icon?: LucideIconName;
  label: string;
  onPress?: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      cssInterop={false}
      testID={testID}
      accessibilityRole={onPress ? 'button' : 'text'}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        edge,
        {
          minHeight: 30,
          paddingHorizontal: 10,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <SystemIcon name="circle" mdName={icon} size={13} color={home.secondary} />
      <Text
        numberOfLines={1}
        style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: home.text }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Attendees as overlapping initials circles, then a grey "+N"; the row opens the people list. */
export function AttendeeCircles({
  people,
  onPress,
  limit = 2,
}: {
  people: { name: string | null; email: string | null }[];
  onPress: () => void;
  limit?: number;
}) {
  const t = useNotesT();
  if (people.length === 0) return null;
  const shown = people.slice(0, limit);
  const more = people.length - shown.length;
  const label = [
    ...shown.map((person) => person.name || person.email || ''),
    ...(more > 0 ? [t('moreAttendees', { count: more })] : []),
  ].join(', ');
  const circle = (text: string, grey: boolean, index: number) => (
    <View
      key={index}
      style={[
        grey
          ? { backgroundColor: look.idleFill, borderWidth: 1, borderColor: look.hairline }
          : edge,
        {
          width: 30,
          height: 30,
          borderRadius: 15,
          marginLeft: index === 0 ? 0 : -4,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Text
        style={{
          fontSize: 11,
          lineHeight: 14,
          fontWeight: '600',
          color: grey ? home.secondary : home.text,
        }}
      >
        {text}
      </Text>
    </View>
  );
  return (
    <Pressable
      cssInterop={false}
      testID="note-attendees"
      accessibilityRole="button"
      accessibilityLabel={`${t('attendees')}: ${label}`}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ flexDirection: 'row', opacity: pressed ? 0.7 : 1 })}
    >
      {shown.map((person, index) => circle(initialsOf(person.name || person.email), false, index))}
      {more > 0 ? circle(`+${more}`, true, shown.length) : null}
    </Pressable>
  );
}

export type NoteTab = 'enhanced' | 'notes' | 'transcript';

/** Summary | Notes | Transcript, in Android's one tab style (Dictionary's Words | Snippets). */
export function NoteTabs({
  tabs,
  value,
  onChange,
  disabled,
  testIDPrefix = 'note-tab',
}: {
  tabs: { key: NoteTab; label: string; dot?: boolean }[];
  value: NoteTab;
  onChange: (tab: NoteTab) => void;
  disabled?: boolean;
  testIDPrefix?: string;
}) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={tabs.map((tab) => ({
        value: tab.key,
        label: tab.label,
        dot: tab.dot,
        testID: `${testIDPrefix}-${tab.key}`,
      }))}
    />
  );
}

/** A white chip with a 10% hairline: the template chip and Make shorter/longer. */
export function SoftChip({
  label,
  icon,
  trailing,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  icon?: LucideIconName;
  trailing?: LucideIconName;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      cssInterop={false}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 32,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: 'rgba(0,0,0,0.10)',
        backgroundColor: pressed ? '#F7F7F6' : home.surface,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {icon ? <SystemIcon name="circle" mdName={icon} size={14} color={home.accent} /> : null}
      <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: home.text }}>
        {label}
      </Text>
      {trailing ? (
        <SystemIcon name="circle" mdName={trailing} size={14} color={home.secondary} />
      ) : null}
    </Pressable>
  );
}

/** E5 while a summary is being written: grey lines that breathe (still under reduced motion). */
export function Shimmer({ lines = 6 }: { lines?: number }) {
  const reduce = useReduceMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.45, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduce]);
  const widths = ['92%', '100%', '78%', '96%', '64%', '88%', '72%'];
  return (
    <Animated.View style={{ gap: 14, opacity, paddingVertical: 6 }}>
      {Array.from({ length: lines }, (_, index) => (
        <View
          key={index}
          style={{
            height: 10,
            borderRadius: 5,
            width: widths[index % widths.length] as `${number}%`,
            backgroundColor: look.track,
          }}
        />
      ))}
    </Animated.View>
  );
}

/** E1b: the brand-glass sparkle circle, the line under it and the glass Write summary. */
export function NoSummaryCard({
  body,
  templateName,
  onWrite,
  onTemplate,
  disabled,
  hint,
}: {
  body: string;
  templateName: string;
  onWrite: () => void;
  onTemplate: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  const t = useNotesT();
  return (
    <View style={[edgeCard, { padding: 20, alignItems: 'center', gap: 12 }]}>
      <View
        style={[
          {
            width: 48,
            height: 48,
            borderRadius: 24,
            alignItems: 'center',
            justifyContent: 'center',
          },
          gloss,
        ]}
      >
        <SystemIcon name="sparkles" mdName="Sparkles" size={22} color="#FFFFFF" />
      </View>
      <Text style={[notesLook.rowTitle, { textAlign: 'center' }]}>{t('noSummary')}</Text>
      <Text
        style={{
          fontSize: 15,
          lineHeight: 21,
          color: home.secondary,
          textAlign: 'center',
        }}
      >
        {body}
      </Text>
      <Pressable
        cssInterop={false}
        testID="write-summary"
        accessibilityRole="button"
        accessibilityState={{ disabled: Boolean(disabled) }}
        disabled={disabled}
        onPress={onWrite}
        style={({ pressed }) => [
          {
            alignSelf: 'stretch',
            minHeight: 48,
            borderRadius: 999,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            opacity: disabled ? 0.5 : 1,
          },
          gloss,
          pressed && !disabled && glossPressed,
        ]}
      >
        <SystemIcon name="sparkles" mdName="Sparkles" size={18} color="#FFFFFF" />
        <Text style={{ color: '#FFFFFF', fontSize: 17, lineHeight: 22, fontWeight: '600' }}>
          {t('writeSummary')}
        </Text>
      </Pressable>
      {hint ? (
        <Text style={{ fontSize: 13, lineHeight: 18, color: home.secondary, textAlign: 'center' }}>
          {hint}
        </Text>
      ) : (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          onPress={onTemplate}
          hitSlop={8}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: home.accent, fontSize: 14, lineHeight: 20, fontWeight: '500' }}>
            {t('templateLabel', { name: templateName })}
          </Text>
          <SystemIcon name="chevron.down" mdName="ChevronDown" size={14} color={home.accent} />
        </Pressable>
      )}
    </View>
  );
}

/** E3: who said what, a time beside each name; a voice guess shows "Is this Priya?". */
export function TranscriptCard({
  blocks,
  onSpeakerPress,
  onCopy,
}: {
  blocks: TranscriptBlock[];
  onSpeakerPress: (block: TranscriptBlock) => void;
  onCopy?: () => void;
}) {
  const t = useNotesT();
  return (
    <View style={{ gap: 8 }}>
      <View style={[edgeCard, { padding: 16, gap: 16 }]} testID="speaker-transcript">
        {blocks.length === 0 ? (
          <Text style={{ fontSize: 15, color: home.tertiary }}>{t('noTranscript')}</Text>
        ) : (
          blocks.map((block) => {
            const suggested = block.speakerStatus === 'suggested';
            const name = block.speakerName.replace(/\?$/, '');
            return (
              <View key={block.id} style={{ gap: 4 }}>
                <Pressable
                  cssInterop={false}
                  accessibilityRole="button"
                  disabled={block.speakerId == null}
                  onPress={() => onSpeakerPress(block)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 }}
                >
                  <Text
                    style={{
                      fontSize: 13,
                      lineHeight: 18,
                      fontWeight: '600',
                      color: block.speakerColor || home.accent,
                    }}
                  >
                    {suggested ? block.speakerLabel || name : name}
                  </Text>
                  <Text style={{ fontSize: 12, lineHeight: 16, color: home.tertiary }}>
                    {block.timestamp}
                  </Text>
                  {suggested ? (
                    <View
                      style={{
                        paddingHorizontal: 6,
                        paddingVertical: 1,
                        borderRadius: 6,
                        backgroundColor: look.selFill,
                      }}
                    >
                      <Text style={{ fontSize: 12, lineHeight: 16, color: home.accent }}>
                        {t('isThis', { name })}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
                <Text selectable style={{ fontSize: 16, lineHeight: 23, color: home.text }}>
                  {block.text}
                </Text>
              </View>
            );
          })
        )}
      </View>
      {onCopy && blocks.length > 0 ? (
        <View style={{ paddingHorizontal: 4 }}>
          <LinkButton label={t('copyTranscript')} icon="Copy" onPress={onCopy} />
        </View>
      ) : null}
    </View>
  );
}

/** E2's bar above the keyboard: bold, italic, bullet, checklist, heading, and Done. */
export function FormatBar({
  onFormat,
  onDone,
}: {
  onFormat: (kind: 'bold' | 'italic' | 'bullet' | 'check' | 'heading') => void;
  onDone: () => void;
}) {
  const t = useNotesT();
  const item = (
    kind: 'bold' | 'italic' | 'bullet' | 'check' | 'heading',
    icon: LucideIconName,
    label: string,
  ) => (
    <Pressable
      key={kind}
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onFormat(kind)}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.5 : 1,
      })}
    >
      <SystemIcon name="circle" mdName={icon} size={20} color={home.text} />
    </Pressable>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        backgroundColor: home.surface,
        borderTopWidth: 1,
        borderTopColor: look.hairline,
      }}
    >
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
      >
        {item('bold', 'Bold', t('bold'))}
        {item('italic', 'Italic', t('italic'))}
        {item('bullet', 'List', t('bullet'))}
        {item('check', 'SquareCheck', t('checklist'))}
        {item('heading', 'Heading', t('heading'))}
      </ScrollView>
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        onPress={onDone}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 12,
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: home.accent, fontSize: 16, fontWeight: '600' }}>{t('done')}</Text>
      </Pressable>
    </View>
  );
}

/** Applies a FormatBar choice to the text at the selection; returns the text and new caret. */
export function applyFormat(
  text: string,
  selection: { start: number; end: number },
  kind: 'bold' | 'italic' | 'bullet' | 'check' | 'heading',
): { text: string; caret: number } {
  const { start, end } = selection;
  if (kind === 'bold' || kind === 'italic') {
    const mark = kind === 'bold' ? '**' : '_';
    const inner = text.slice(start, end);
    const next = text.slice(0, start) + mark + inner + mark + text.slice(end);
    return { text: next, caret: end + mark.length * (inner ? 2 : 1) };
  }
  const prefix = kind === 'bullet' ? '- ' : kind === 'check' ? '- [ ] ' : '## ';
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const line = text.slice(lineStart);
  if (line.startsWith(prefix)) {
    const next = text.slice(0, lineStart) + line.slice(prefix.length);
    return { text: next, caret: Math.max(lineStart, start - prefix.length) };
  }
  const next = text.slice(0, lineStart) + prefix + line;
  return { text: next, caret: start + prefix.length };
}
