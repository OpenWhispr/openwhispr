import type React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';

interface VoiceSetupBannerProps {
  onSetUp: () => void;
  onDismiss: () => void;
}

export function VoiceSetupBanner({ onSetUp, onDismiss }: VoiceSetupBannerProps): React.JSX.Element {
  return (
    <View
      className="mb-4 flex-row items-start gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-3"
      style={{ borderCurve: 'continuous' }}
      testID="voice-setup-banner"
    >
      <View className="h-9 w-9 items-center justify-center rounded-lg bg-tertiarySystemFill">
        <SystemIcon name="waveform" mdName="AudioLines" size={20} color="brand" />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-semibold text-label">Teach OpenWhispr your voice</Text>
        <Text className="text-[13px] leading-[18px] text-secondaryLabel">
          Your next on-device meetings will label you as Me.
        </Text>
        <Pressable
          onPress={onSetUp}
          accessibilityRole="button"
          testID="voice-setup-banner-set-up"
          className="mt-2.5 h-9 items-center justify-center self-start rounded-lg bg-brand px-3.5"
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, borderCurve: 'continuous' })}
        >
          <Text className="text-[14px] font-semibold text-white">Set Up</Text>
        </Pressable>
      </View>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss voice setup"
        testID="voice-setup-banner-dismiss"
        hitSlop={8}
        className="h-9 w-8 items-center justify-center"
      >
        <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
      </Pressable>
    </View>
  );
}
