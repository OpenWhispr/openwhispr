import { useState } from 'react';
import type React from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { iosColor } from '@/config/colors';
import { MeetingTabs, type MeetingTab } from './MeetingTabs';
import { LiveTranscriptList } from './LiveTranscriptList';
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';
import type { CloudMeetingStatus } from '@/hooks/useCloudMeeting';

const formatClock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

const STATUS_LABEL: Record<CloudMeetingStatus, string> = {
  connecting: 'CONNECTING',
  live: 'RECORDING',
  reconnecting: 'RECONNECTING',
  error: 'DISCONNECTED',
};

interface CloudMeetingRecordingProps {
  status: CloudMeetingStatus;
  error: string | null;
  elapsedSeconds: number;
  rawNotes: string;
  onChangeRawNotes: (text: string) => void;
  utterances: RealtimeUtterance[];
  partialText: string;
  onStop: () => void;
}

/**
 * Presentational cloud-meeting recording UI (Variant C, interim in-app timer —
 * the Dynamic Island Live Activity is a deferred follow-up). A persistent status
 * bar (red dot + status + timer) sits above a Notes / Live Transcript segmented
 * control, with a full-width Stop pinned to the bottom so it never moves between
 * tabs. All state is owned by the caller; this component only renders + reports.
 */
export function CloudMeetingRecording({
  status,
  error,
  elapsedSeconds,
  rawNotes,
  onChangeRawNotes,
  utterances,
  partialText,
  onStop,
}: CloudMeetingRecordingProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  // The meeting-record route uses a transparent (glass) header, so content renders
  // behind it from y=0 — offset below it or the status bar overlaps the timer card.
  const headerHeight = useHeaderHeight();
  const [tab, setTab] = useState<MeetingTab>('transcript');
  const footerBottomPadding = Math.max(insets.bottom + 16, 24);

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-systemBackground"
      style={{ paddingTop: headerHeight }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <View
        className="mx-4 mt-1 flex-row items-center gap-3 rounded-[22px] border border-separator bg-secondarySystemGroupedBackground p-4 shadow-sm"
        style={{ borderCurve: 'continuous' }}
      >
        <View className="h-2.5 w-2.5 rounded-full bg-systemRed" />
        <View>
          <Text className="text-[12px] font-semibold tracking-wide text-secondaryLabel">
            {STATUS_LABEL[status]}
          </Text>
          <Text
            className="text-[26px] font-semibold leading-none text-label"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {formatClock(elapsedSeconds)}
          </Text>
        </View>
      </View>
      {status === 'error' && error ? (
        <Text className="mx-4 mt-2 text-[13px] text-systemRed">{error}</Text>
      ) : null}
      {status === 'reconnecting' ? (
        <Text className="mx-4 mt-2 text-[13px] text-systemOrange">
          Reconnecting — recording continues
        </Text>
      ) : null}

      <View className="mx-4 mt-3.5">
        <MeetingTabs active={tab} onChange={setTab} />
      </View>

      <View className="flex-1 px-4 pb-2 pt-4">
        {tab === 'notes' ? (
          <View
            className="flex-1 rounded-[22px] border border-separator bg-secondarySystemGroupedBackground p-4 shadow-sm"
            style={{ borderCurve: 'continuous' }}
          >
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-[15px] font-semibold text-label">Meeting notes</Text>
              <Text className="text-[12px] font-medium text-tertiaryLabel">Draft</Text>
            </View>
            <TextInput
              testID="meeting-raw-notes"
              value={rawNotes}
              onChangeText={onChangeRawNotes}
              placeholder="Jot decisions, follow-ups, or context while recording..."
              placeholderTextColor={iosColor('tertiaryLabel')}
              multiline
              textAlignVertical="top"
              className="min-h-[120px] flex-1 text-[16px] leading-6 text-label"
            />
          </View>
        ) : (
          <LiveTranscriptList utterances={utterances} partialText={partialText} />
        )}
      </View>

      <View className="px-4 pt-2" style={{ paddingBottom: footerBottomPadding }}>
        <Button testID="meeting-stop" variant="destructive" size="lg" onPress={onStop}>
          Stop
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
}
