import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { CHAT_COLORS } from '@/config/colors';

export type ChatUnansweredReason = 'failed' | 'stopped' | 'unanswered';

interface ChatErrorRowProps {
  /** Why the question has no answer; 'unanswered' is one saved without one, e.g. before a relaunch. */
  reason?: ChatUnansweredReason;
  /** What went wrong, shown only for a failure. */
  message?: string;
  /** While Chat is off, another turn runs or a question is being spoken, neither button acts. */
  disabled: boolean;
  onRetry: () => void;
  onEdit: () => void;
}

export function ChatErrorRow({
  reason = 'failed',
  message,
  disabled,
  onRetry,
  onEdit,
}: ChatErrorRowProps): React.JSX.Element {
  const failed = reason === 'failed';
  return (
    <View className="flex-row gap-3" accessibilityRole={failed ? 'alert' : undefined}>
      <View
        className="h-8 w-8 items-center justify-center rounded-[10px]"
        style={failed ? styles.icon : styles.neutralIcon}
      >
        {failed ? (
          <SystemIcon
            name="exclamationmark.triangle"
            mdName="TriangleAlert"
            size={16}
            color={CHAT_COLORS.errorForeground}
          />
        ) : (
          <SystemIcon name="info.circle" mdName="Info" size={16} color="secondaryLabel" />
        )}
      </View>
      <View className="flex-1">
        <Text className="text-[16px] font-semibold text-label">{TITLES[reason]}</Text>
        <Text className="mt-0.5 text-[14px] leading-5 text-secondaryLabel">
          {failed && message ? `${message} ${SAVED}` : SAVED}
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

const TITLES: Record<ChatUnansweredReason, string> = {
  failed: 'Couldn’t get an answer',
  stopped: 'Stopped',
  unanswered: 'Not answered',
};

const SAVED = 'Your question is saved.';

const styles = StyleSheet.create({
  icon: { backgroundColor: CHAT_COLORS.errorBackground },
  neutralIcon: { backgroundColor: CHAT_COLORS.neutralTrack },
  primary: { backgroundColor: CHAT_COLORS.darkFill },
  secondary: { borderWidth: StyleSheet.hairlineWidth, borderColor: CHAT_COLORS.hairline },
  disabled: { opacity: 0.4 },
});
