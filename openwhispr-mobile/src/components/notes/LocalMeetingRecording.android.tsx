import type React from 'react';
import { TextInput, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { iosColor } from '@/config/colors';
import { Sentry } from '@/lib/sentry';

const formatClock = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

export function LocalMeetingRecording({
  count,
  elapsedSeconds,
  keyboardHeight,
  bottomInset,
  headerHeight,
  rawNotes,
  setRawNotes,
  onStop,
}: {
  count: number | undefined;
  elapsedSeconds: number;
  keyboardHeight: number;
  bottomInset: number;
  headerHeight: number;
  rawNotes: string;
  setRawNotes: (value: string) => void;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const countLabel =
    count != null ? `${count} ${count === 1 ? 'person' : 'people'}` : 'Auto-detecting';
  // The view fills the screen, so the keyboard covers the home-indicator inset too.
  const footerBottomPadding =
    keyboardHeight > 0 ? keyboardHeight + 12 : Math.max(bottomInset + 32, 56);
  return (
    <View className="flex-1 bg-systemBackground px-6" style={{ paddingTop: headerHeight }}>
      <View className="items-center pb-2 pt-4">
        <View className="mb-3 flex-row items-center gap-2">
          <View className="h-2 w-2 rounded-full bg-systemRed" />
          <Text className="text-[14px] font-medium text-secondaryLabel">Recording</Text>
        </View>
        <Text
          className="text-[60px] font-semibold leading-none tracking-tight text-label"
          style={{ fontVariant: ['tabular-nums'] }}
        >
          {formatClock(elapsedSeconds)}
        </Text>
        <View className="mt-5 flex-row gap-2">
          <View
            className="rounded-full border border-separator bg-secondarySystemGroupedBackground px-3 py-1.5"
            style={{ borderCurve: 'continuous' }}
          >
            <Text className="text-[12px] font-semibold text-secondaryLabel">{countLabel}</Text>
          </View>
          <View
            className="rounded-full border border-separator bg-secondarySystemGroupedBackground px-3 py-1.5"
            style={{ borderCurve: 'continuous' }}
          >
            <Text className="text-[12px] font-semibold text-secondaryLabel">On-device</Text>
          </View>
        </View>
      </View>
      <View
        className="mb-4 mt-6 flex-1 rounded-[22px] border border-separator bg-secondarySystemGroupedBackground p-4 shadow-sm"
        style={{ borderCurve: 'continuous' }}
      >
        <View className="mb-2 flex-row items-center justify-between">
          <Text className="text-[15px] font-semibold text-label">Meeting notes</Text>
          <Text className="text-[12px] font-medium text-tertiaryLabel">Draft</Text>
        </View>
        <TextInput
          testID="meeting-raw-notes"
          value={rawNotes}
          onChangeText={setRawNotes}
          placeholder="Jot decisions, follow-ups, or context while recording..."
          placeholderTextColor={iosColor('tertiaryLabel')}
          multiline
          textAlignVertical="top"
          className="flex-1 text-[16px] leading-6 text-label"
        />
      </View>
      <View style={{ paddingBottom: footerBottomPadding }}>
        <Button
          testID="meeting-stop"
          variant="destructive"
          size="lg"
          onPress={() => {
            onStop().catch(Sentry.captureException);
          }}
        >
          Stop
        </Button>
      </View>
    </View>
  );
}
