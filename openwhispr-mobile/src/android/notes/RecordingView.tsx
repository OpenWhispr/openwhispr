import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useNavigation } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { useNavigationBarCanvas } from '../navigationBar';
import { IconButton, useNotesLook } from './look';
import { MetaChip, NoteTabs, type NoteTab } from './noteParts';
import { useNotesT } from './strings';
import { useReduceMotion } from '../settings/kit';
import { AndroidDictation } from '../../../modules/android-dictation/src';

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
const BAR_MAX = 18;
const MAX_BARS = 80;
const TICK_MS = 80;

// The recorder reports -60..-20 dBFS as 0..1. A meeting mic hears people across a room, so
// speech sits lower than in Try it (held close): start the bars at 0.15, full at 0.6.
const barHeight = (level: number) =>
  Math.max(3, Math.round(Math.min(1, Math.max(0, (level - 0.15) / 0.45)) * BAR_MAX));

/** Each bar leans on the one before it, so the shape rises and falls rather than flickering. */
export const smoothLevel = (previous: number, level: number) => previous * 0.45 + level * 0.55;

/**
 * The meeting's loudness as bars filling the rest of the status pill, newest on the right, so
 * the user can see the phone hears the room. The row glides left between readings instead of
 * jumping a bar at a time (not with reduced motion). Flat while it connects or reconnects, and
 * absent on builds whose native module can't report the level.
 */
function MeetingWaveform({ live }: { live: boolean }) {
  const [width, setWidth] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(MAX_BARS).fill(0));
  const n = useNotesLook();
  const reduceMotion = useReduceMotion();
  const offset = useRef(new Animated.Value(0)).current;
  const readLevel = AndroidDictation?.getMeetingLevel;
  useEffect(() => {
    if (!live || !readLevel) return;
    const timer = setInterval(() => {
      const level = readLevel() ?? 0;
      setLevels((previous) => [
        ...previous.slice(1),
        smoothLevel(previous[previous.length - 1], level),
      ]);
      if (!reduceMotion) {
        offset.setValue(BAR_STEP);
        Animated.timing(offset, {
          toValue: 0,
          duration: TICK_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }).start();
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [live, readLevel, reduceMotion, offset]);
  if (!readLevel) return null;
  // One bar more than fits, so the oldest slides out under the pill's edge.
  const count = Math.max(0, Math.min(MAX_BARS, Math.floor((width + BAR_GAP) / BAR_STEP) + 1));
  return (
    <View
      testID="meeting-waveform"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ flex: 1, height: BAR_MAX, overflow: 'hidden' }}
    >
      <Animated.View
        testID="meeting-waveform-bars"
        style={[
          {
            position: 'absolute',
            right: 0,
            height: BAR_MAX,
            flexDirection: 'row',
            alignItems: 'center',
            gap: BAR_GAP,
          },
          { transform: [{ translateX: offset }] },
        ]}
      >
        {levels.slice(MAX_BARS - count).map((level, index) => (
          <View
            key={index}
            style={{
              width: BAR_WIDTH,
              height: live ? barHeight(level) : 3,
              borderRadius: 999,
              backgroundColor: live ? n.accent : n.tertiary,
            }}
          />
        ))}
      </Animated.View>
    </View>
  );
}

const clock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export type RecordingStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

/**
 * Figma R1: the tab bar and header go away; a white status pill (red dot, time) sits beside
 * a ∨ that goes back to the notes; the meeting's title and chips; Live transcript and Notes
 * as two tabs; and one glass Stop and save at the bottom. No pause for beta.
 */
export function RecordingView({
  status,
  error,
  elapsedSeconds,
  title,
  chips,
  meta,
  rawNotes,
  onChangeRawNotes,
  transcript,
  stopLabel,
  onStop,
  keyboardHeight,
}: {
  status: RecordingStatus;
  error?: string | null;
  elapsedSeconds: number;
  title: string;
  chips: string[];
  /** The note's own chips (folder, people, event), editable while it records; replaces `chips`. */
  meta?: React.ReactNode;
  rawNotes: string;
  onChangeRawNotes: (text: string) => void;
  /** The live transcript; null when this recording is transcribed afterwards (on the phone). */
  transcript: React.ReactNode | null;
  stopLabel?: string;
  onStop: () => void;
  keyboardHeight: number;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const dark = n.theme.scheme === 'dark';
  const insets = useSafeAreaInsets();
  useNavigationBarCanvas(n.canvas);
  // The recorder's own header gives way to this layout while it records.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation]);
  const [tab, setTab] = useState<NoteTab>(transcript ? 'transcript' : 'notes');
  const amber = status === 'reconnecting' || status === 'connecting';
  // The recording red and amber keep their light values; dark lifts them one step.
  const dot =
    status === 'error'
      ? n.tertiary
      : amber
        ? dark
          ? n.theme.tokens.warning
          : '#F59E0B'
        : n.theme.tokens.errorVivid;
  const pill = t(status === 'reconnecting' ? 'reconnecting' : 'recording', {
    time: clock(elapsedSeconds),
  });
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: n.canvas,
        paddingTop: insets.top + 8,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }}>
        <IconButton
          icon="ChevronDown"
          label={t('minimise')}
          onPress={() => (router.canGoBack() ? router.back() : undefined)}
        />
        <View
          accessibilityRole="timer"
          accessibilityLiveRegion="polite"
          style={[
            n.edge,
            {
              flex: 1,
              minHeight: 36,
              borderRadius: 999,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            },
          ]}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: dot,
            }}
          />
          <Text
            style={{
              fontSize: 15,
              lineHeight: 20,
              fontWeight: '600',
              color: n.text,
              fontVariant: ['tabular-nums'],
            }}
          >
            {pill}
          </Text>
          {status === 'error' ? null : <MeetingWaveform live={status === 'live'} />}
        </View>
      </View>
      <View style={{ flex: 1, padding: 16, gap: 12 }}>
        <Text style={n.title} numberOfLines={2}>
          {title}
        </Text>
        {meta ?? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {chips.map((chip) => (
              <MetaChip key={chip} label={chip} />
            ))}
          </View>
        )}
        {status === 'error' && error ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: n.error }}>{error}</Text>
        ) : null}
        {transcript ? (
          <NoteTabs
            tabs={[
              { key: 'transcript', label: t('liveTranscript') },
              { key: 'notes', label: t('myNotes') },
            ]}
            value={tab}
            onChange={setTab}
            testIDPrefix="meeting-tab"
          />
        ) : null}
        {tab === 'transcript' && transcript ? (
          <View style={[n.edgeCard, { flex: 1, padding: 16 }]}>{transcript}</View>
        ) : (
          <View style={[n.edgeCard, { flex: 1, padding: 16 }]}>
            <TextInput
              testID="meeting-raw-notes"
              value={rawNotes}
              onChangeText={onChangeRawNotes}
              placeholder={t('notesWhileRecording')}
              placeholderTextColor={n.tertiary}
              multiline
              textAlignVertical="top"
              style={{
                flex: 1,
                fontFamily: AppFont.regular,
                fontSize: 16,
                lineHeight: 24,
                color: n.text,
                padding: 0,
              }}
            />
          </View>
        )}
      </View>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: keyboardHeight > 0 ? 12 : Math.max(insets.bottom + 16, 24),
        }}
      >
        <Pressable
          cssInterop={false}
          testID="meeting-stop"
          accessibilityRole="button"
          onPress={onStop}
          style={({ pressed }) => [
            {
              minHeight: 52,
              borderRadius: 999,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            },
            n.gloss,
            pressed && n.glossPressed,
          ]}
        >
          <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: n.onGlass }} />
          <Text style={{ color: n.onGlass, fontSize: 17, lineHeight: 22, fontWeight: '600' }}>
            {stopLabel ?? t('stopAndSave')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
