import React, { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useNavigation } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AppFont } from '@/lib/fonts';
import { gloss, glossPressed, home } from '../home/kit';
import { edge, edgeCard, look } from '../settings/look';
import { useNavigationBarCanvas } from '../navigationBar';
import { IconButton, notesLook } from './look';
import { MetaChip, NoteTabs, type NoteTab } from './noteParts';
import { useNotesT } from './strings';

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
  rawNotes: string;
  onChangeRawNotes: (text: string) => void;
  /** The live transcript; null when this recording is transcribed afterwards (on the phone). */
  transcript: React.ReactNode | null;
  stopLabel?: string;
  onStop: () => void;
  keyboardHeight: number;
}) {
  const t = useNotesT();
  const insets = useSafeAreaInsets();
  useNavigationBarCanvas(notesLook.canvas);
  // The recorder's own header gives way to this layout while it records.
  const navigation = useNavigation();
  useEffect(() => {
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation]);
  const [tab, setTab] = useState<NoteTab>(transcript ? 'transcript' : 'notes');
  const amber = status === 'reconnecting' || status === 'connecting';
  const pill = t(status === 'reconnecting' ? 'reconnecting' : 'recording', {
    time: clock(elapsedSeconds),
  });
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: notesLook.canvas,
        paddingTop: insets.top + 8,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }}>
        <IconButton
          icon="ChevronDown"
          label={t('minimise')}
          color={home.accent}
          onPress={() => (router.canGoBack() ? router.back() : undefined)}
        />
        <View
          accessibilityRole="timer"
          accessibilityLiveRegion="polite"
          style={[
            edge,
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
              backgroundColor: status === 'error' ? home.tertiary : amber ? '#F59E0B' : '#E5372B',
            }}
          />
          <Text
            style={{
              fontSize: 15,
              lineHeight: 20,
              fontWeight: '600',
              color: home.text,
              fontVariant: ['tabular-nums'],
            }}
          >
            {pill}
          </Text>
        </View>
      </View>
      <View style={{ flex: 1, padding: 16, gap: 12 }}>
        <Text style={notesLook.title} numberOfLines={2}>
          {title}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {chips.map((chip) => (
            <MetaChip key={chip} label={chip} />
          ))}
        </View>
        {status === 'error' && error ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: look.error }}>{error}</Text>
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
          <View style={[edgeCard, { flex: 1, padding: 16 }]}>{transcript}</View>
        ) : (
          <View style={[edgeCard, { flex: 1, padding: 16 }]}>
            <TextInput
              testID="meeting-raw-notes"
              value={rawNotes}
              onChangeText={onChangeRawNotes}
              placeholder={t('notesWhileRecording')}
              placeholderTextColor={home.tertiary}
              multiline
              textAlignVertical="top"
              style={{
                flex: 1,
                fontFamily: AppFont.regular,
                fontSize: 16,
                lineHeight: 24,
                color: home.text,
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
            gloss,
            pressed && glossPressed,
          ]}
        >
          <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: '#FFFFFF' }} />
          <Text style={{ color: '#FFFFFF', fontSize: 17, lineHeight: 22, fontWeight: '600' }}>
            {stopLabel ?? t('stopAndSave')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** "Listening…" under the live transcript, as in R1. */
export function ListeningLine() {
  const t = useNotesT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 4 }}>
      <SystemIcon name="waveform" mdName="AudioLines" size={14} color={home.accent} />
      <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: home.accent }}>
        {t('listening')}
      </Text>
    </View>
  );
}
