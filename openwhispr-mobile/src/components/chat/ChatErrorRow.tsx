import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { CHAT_COLORS } from '@/config/colors';

interface ChatErrorRowProps {
  message: string;
  /** While Chat is off, another turn runs or a question is being spoken, neither button acts. */
  disabled: boolean;
  onRetry: () => void;
  onEdit: () => void;
}

export function ChatErrorRow({
  message,
  disabled,
  onRetry,
  onEdit,
}: ChatErrorRowProps): React.JSX.Element {
  return (
    <View className="flex-row gap-3" accessibilityRole="alert">
      <View className="h-8 w-8 items-center justify-center rounded-[10px]" style={styles.icon}>
        <SystemIcon
          name="exclamationmark.triangle"
          mdName="TriangleAlert"
          size={16}
          color={CHAT_COLORS.errorForeground}
        />
      </View>
      <View className="flex-1">
        <Text className="text-[16px] font-semibold text-label">Couldn’t get an answer</Text>
        <Text className="mt-0.5 text-[14px] leading-5 text-secondaryLabel">
          {message} Your question is saved.
        </Text>
        <View className="mt-3 flex-row gap-2" style={disabled ? styles.disabled : undefined}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onRetry}
            className="min-h-[44px] flex-row items-center justify-center gap-1.5 rounded-[10px] px-4 active:opacity-70"
            style={styles.primary}
          >
            <SystemIcon
              name="arrow.clockwise"
              mdName="RotateCcw"
              size={14}
              color={CHAT_COLORS.onGradient}
            />
            <Text className="text-[15px] font-medium text-white">Retry</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit question"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onEdit}
            className="min-h-[44px] items-center justify-center rounded-[10px] bg-secondarySystemGroupedBackground px-4 active:opacity-70"
            style={styles.secondary}
          >
            <Text className="text-[15px] font-medium text-label">Edit question</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { backgroundColor: CHAT_COLORS.errorBackground },
  primary: { backgroundColor: CHAT_COLORS.darkFill },
  secondary: { borderWidth: StyleSheet.hairlineWidth, borderColor: CHAT_COLORS.hairline },
  disabled: { opacity: 0.4 },
});
