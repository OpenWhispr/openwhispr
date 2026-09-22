import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';

interface VoiceProfilePromptCardProps {
  visible: boolean;
  onEnroll: () => void;
  onDismiss: () => void;
}

export function VoiceProfilePromptCard({
  visible,
  onEnroll,
  onDismiss,
}: VoiceProfilePromptCardProps) {
  if (!visible) return null;

  return (
    <View
      className="mb-4 gap-3 rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4"
      style={{ borderCurve: 'continuous' }}
      testID="voice-profile-prompt-card"
    >
      <View className="flex-row items-start gap-3">
        <View className="h-9 w-9 items-center justify-center rounded-lg bg-tertiarySystemFill">
          <SystemIcon name="waveform" mdName="AudioLines" size={20} color="brand" />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-[16px] font-semibold text-label">Enroll your voice</Text>
          <Text className="text-[14px] leading-5 text-secondaryLabel">
            Future meetings can label you more accurately. The voiceprint stays on this device.
          </Text>
        </View>
      </View>
      <View className="flex-row gap-3">
        <Pressable
          onPress={onEnroll}
          accessibilityRole="button"
          accessibilityLabel="Enroll Me"
          testID="voice-profile-prompt-enroll"
          className="h-9 items-center justify-center rounded-lg bg-brand px-4"
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, borderCurve: 'continuous' })}
        >
          <Text className="text-[14px] font-semibold text-white">Enroll Me</Text>
        </Pressable>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss voice profile prompt"
          testID="voice-profile-prompt-dismiss"
          className="h-9 items-center justify-center rounded-lg bg-tertiarySystemFill px-4"
          style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1, borderCurve: 'continuous' })}
        >
          <Text className="text-[14px] font-medium text-label">Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}
