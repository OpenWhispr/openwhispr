import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Extrapolation,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import type { Note } from '@/data';
import { parseNoteTimestamp } from '@/lib/parseNoteTimestamp';
import { home } from '../home/kit';
import { look } from '../settings/look';
import { useReduceMotion } from '../settings/kit';
import { NoteTile, notesLook } from './look';
import { consumeRestored } from './pendingDeletes';
import { useNotesT, type NotesT } from './strings';

export type NoteKind = 'meeting' | 'upload' | 'note';

export function noteKind(note: Pick<Note, 'noteType' | 'diarizationEnabled'>): NoteKind {
  if (note.noteType === 'upload') return 'upload';
  if (note.noteType === 'meeting' || note.diarizationEnabled === 1) return 'meeting';
  return 'note';
}

export function kindIcon(kind: NoteKind): { icon: LucideIconName; color: string } {
  return kind === 'note'
    ? { icon: 'FileText', color: home.secondary }
    : { icon: 'AudioLines', color: home.accent };
}

/** Markdown to one readable line: no headings, bullets, checkboxes or emphasis marks. */
export function plainLine(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/[*_`~]+/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim();
    // A heading on its own ("Decisions") says nothing; the first line under it does.
    if (line && !/^#{1,6}\s/.test(raw.trim())) return line;
  }
  return '';
}

/** The line under a note's title: the summary's first point, else what was typed. */
export function notePreview(note: Note): string {
  return (
    plainLine(note.enhancedContent ?? '') || (note.content ?? '').replace(/\s+/g, ' ').trim() || ''
  );
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = parseNoteTimestamp(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function dayOf(iso: string | null | undefined, t: NotesT): string {
  if (!iso) return '';
  const date = parseNoteTimestamp(iso);
  if (Number.isNaN(date.getTime())) return '';
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(date)) / 86400000);
  if (days === 0) return t('today');
  if (days === 1) return t('yesterday');
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function kindLabel(note: Note, t: NotesT): string {
  const kind = noteKind(note);
  return t(kind === 'meeting' ? 'kindMeeting' : kind === 'upload' ? 'kindUpload' : 'kindNote');
}

/** "Meeting · 32 min · 10:00". */
export function noteMeta(note: Note, t: NotesT): string {
  const kind = noteKind(note);
  const parts = [kindLabel(note, t)];
  const seconds = note.audioDurationSeconds ?? 0;
  if (kind !== 'note' && seconds > 0)
    parts.push(t('minutes', { count: Math.max(1, Math.round(seconds / 60)) }));
  const time = timeOf(note.createdAt ?? note.updatedAt);
  if (time) parts.push(time);
  return parts.join(' · ');
}

type RowProps = {
  note: Note;
  onPress: () => void;
  onLongPress?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  /** Overrides the second line (search shows where the match was). */
  detail?: React.ReactNode;
  /** Overrides the meta line. */
  meta?: string;
};

/** One note in a card: grey tile, title, the summary's first line, and its meta. */
export function NoteRow({
  note,
  onPress,
  onLongPress,
  selectMode,
  selected,
  detail,
  meta,
}: RowProps) {
  const t = useNotesT();
  const kind = noteKind(note);
  const { icon, color } = kindIcon(kind);
  const title = note.title?.trim() || t('untitled');
  const preview = notePreview(note);
  const metaLine = meta ?? noteMeta(note, t);
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole={selectMode ? 'checkbox' : 'button'}
      accessibilityState={selectMode ? { checked: Boolean(selected) } : undefined}
      accessibilityLabel={[title, preview, metaLine].filter(Boolean).join(', ')}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 14,
        paddingRight: 12,
        paddingVertical: 12,
        backgroundColor: selected ? notesLook.selectedRow : pressed ? '#F7F7F6' : home.surface,
      })}
    >
      {selectMode && <SelectCircle selected={Boolean(selected)} />}
      <NoteTile icon={icon} color={color} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={notesLook.rowTitle}>
          {title}
        </Text>
        {detail ??
          (preview ? (
            <Text numberOfLines={1} style={notesLook.rowSub}>
              {preview}
            </Text>
          ) : null)}
        {metaLine ? (
          <Text numberOfLines={1} style={notesLook.rowMeta}>
            {metaLine}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function SelectCircle({ selected }: { selected: boolean }) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: selected ? 0 : 1.5,
        borderColor: 'rgba(0,0,0,0.25)',
        backgroundColor: selected ? home.accent : 'transparent',
      }}
    >
      {selected && <SystemIcon name="checkmark" mdName="Check" size={15} color="#FFFFFF" />}
    </View>
  );
}

const ACTION_WIDTH = 74;

/**
 * Figma L9, swipe left. A short swipe settles 148 dp left on Move and Delete; past half the
 * row the red turns solid, the phone ticks, and letting go deletes: the row slides away
 * (200 ms), the gap closes (180 ms), then `onDelete`. Reduced motion skips the slides.
 * TalkBack gets Move and Delete as actions instead.
 */
export function SwipeRow({
  children,
  onDelete,
  onMove,
  noteId,
  restored,
  enabled = true,
}: {
  children: React.ReactNode;
  onDelete: () => void;
  /** Without it the row offers Delete alone and settles 74 dp open (Dictionary's C4a). */
  onMove?: () => void;
  /** A note row: Undo of its delete plays the row back in (`consumeRestored`). */
  noteId?: number;
  /** For rows that aren't notes: this row is coming back from an Undo. */
  restored?: boolean;
  enabled?: boolean;
}) {
  const t = useNotesT();
  const OPEN_OFFSET = onMove ? ACTION_WIDTH * 2 : ACTION_WIDTH;
  const reduceMotion = useReduceMotion();
  const { width: screenWidth } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState(screenWidth - 32);
  const [measured, setMeasured] = useState(0);
  const x = useSharedValue(0);
  const start = useSharedValue(0);
  const armed = useSharedValue(0);
  const height = useSharedValue(-1);
  const [open, setOpen] = useState(false);
  const restoring = useRef(noteId != null ? consumeRestored(noteId) : Boolean(restored));

  // Undo plays the delete backwards: the gap opens, then the row slides in from the left.
  useEffect(() => {
    if (!restoring.current || !measured) return;
    restoring.current = false;
    if (reduceMotion) return;
    height.value = 0;
    x.value = -rowWidth;
    height.value = withTiming(measured, { duration: 180 }, () => {
      x.value = withTiming(0, { duration: 200, easing: Easing.out(Easing.cubic) });
    });
  }, [measured, reduceMotion, rowWidth, height, x]);

  const tick = (strong: boolean) => safeHaptics(strong ? 'light' : 'selection');
  const finishDelete = () => {
    setOpen(false);
    onDelete();
  };
  const removeRow = () => {
    'worklet';
    if (reduceMotion) {
      runOnJS(finishDelete)();
      return;
    }
    x.value = withTiming(-rowWidth, { duration: 200, easing: Easing.out(Easing.cubic) }, () => {
      height.value = withTiming(0, { duration: 180 }, () => runOnJS(finishDelete)());
    });
  };

  const close = () => {
    x.value = withTiming(0, { duration: reduceMotion ? 0 : 180 });
    setOpen(false);
  };

  const pan = Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onStart(() => {
      start.value = x.value;
    })
    .onUpdate((event) => {
      const next = Math.min(0, start.value + event.translationX);
      x.value = next;
      const past = -next > rowWidth / 2 ? 1 : 0;
      if (past !== armed.value) {
        armed.value = past;
        runOnJS(tick)(past === 1);
      }
    })
    .onEnd(() => {
      const distance = -x.value;
      if (armed.value === 1) {
        armed.value = 0;
        removeRow();
        return;
      }
      if (distance > rowWidth * 0.25) {
        x.value = withTiming(-OPEN_OFFSET, { duration: reduceMotion ? 0 : 180 });
        runOnJS(setOpen)(true);
      } else {
        x.value = withTiming(0, { duration: reduceMotion ? 0 : 180 });
        runOnJS(setOpen)(false);
      }
    });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const wrapStyle = useAnimatedStyle(() =>
    height.value < 0 ? {} : { height: height.value, overflow: 'hidden' },
  );
  // The red: see-through while dragging, solid once armed or past the open buttons.
  const redStyle = useAnimatedStyle(() => {
    const distance = -x.value;
    const besideMove = !armed.value && distance >= OPEN_OFFSET * 0.9;
    const opacity = armed.value
      ? 1
      : interpolate(distance, [0, OPEN_OFFSET], [0.55, 0.85], Extrapolation.CLAMP);
    // With Move showing, Delete keeps its own 74 dp beside it.
    return {
      opacity: distance > 0 ? (besideMove ? 1 : opacity) : 0,
      width: besideMove ? ACTION_WIDTH : Math.max(distance, 0),
      alignItems: armed.value ? 'flex-start' : 'center',
    };
  });
  const moveStyle = useAnimatedStyle(() => {
    const distance = -x.value;
    const show = !armed.value && distance >= OPEN_OFFSET * 0.9;
    return { opacity: show ? 1 : 0 };
  });
  const trashStyle = useAnimatedStyle(() => ({
    transform: [{ scale: armed.value ? 1.25 : 1 }],
  }));

  return (
    <Animated.View
      style={wrapStyle}
      onLayout={(event) => {
        setRowWidth(event.nativeEvent.layout.width);
        if (height.value < 0 && !measured) setMeasured(event.nativeEvent.layout.height);
      }}
      accessibilityActions={[
        { name: 'delete', label: t('delete') },
        ...(onMove ? [{ name: 'move', label: t('move') }] : []),
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'delete') onDelete();
        if (event.nativeEvent.actionName === 'move') onMove?.();
      }}
    >
      <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}>
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 0,
              bottom: 0,
              right: 0,
              backgroundColor: '#C9352B',
              overflow: 'hidden',
            },
            redStyle,
          ]}
        >
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityElementsHidden={!open}
            importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
            onPress={() => removeRow()}
            style={{
              flex: 1,
              width: ACTION_WIDTH,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
            }}
          >
            <Animated.View style={trashStyle}>
              <SystemIcon name="trash" mdName="Trash2" size={20} color="#FFFFFF" />
            </Animated.View>
            <Text style={{ fontSize: 13, lineHeight: 16, fontWeight: '600', color: '#FFFFFF' }}>
              {t('delete')}
            </Text>
          </Pressable>
        </Animated.View>
        {onMove && (
          <Animated.View
            style={[
              {
                position: 'absolute',
                top: 0,
                bottom: 0,
                right: ACTION_WIDTH,
                width: ACTION_WIDTH,
                backgroundColor: '#E8E7E4',
              },
              moveStyle,
            ]}
          >
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              accessibilityElementsHidden={!open}
              importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
              onPress={() => {
                close();
                onMove?.();
              }}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }}
            >
              <SystemIcon name="folder" mdName="Folder" size={20} color={home.text} />
              <Text style={{ fontSize: 13, lineHeight: 16, fontWeight: '500', color: home.text }}>
                {t('move')}
              </Text>
            </Pressable>
          </Animated.View>
        )}
      </View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ backgroundColor: home.surface }, rowStyle]}>
          {open ? (
            // Tap anywhere on an open row closes it instead of opening the note.
            <Pressable cssInterop={false} onPress={close}>
              <View pointerEvents="none">{children}</View>
            </Pressable>
          ) : (
            children
          )}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

export const swipeColors = { red: '#C9352B', grey: look.track };
